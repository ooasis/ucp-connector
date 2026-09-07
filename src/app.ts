/**
 * Multi-tenant UCP/ACP connector: the Hono app shared by the Node server
 * (index.ts) and the Cloudflare Worker (worker.ts).
 *
 * Routes (tenant-scoped, tenant = first path segment):
 *   GET  /{t}/.well-known/ucp                          UCP business profile
 *   GET  /{t}/.well-known/acp.json                     ACP discovery
 *   POST /{t}/ucp/checkout-sessions                    create
 *   GET  /{t}/ucp/checkout-sessions/{id}               view
 *   PUT  /{t}/ucp/checkout-sessions/{id}               update
 *   POST /{t}/ucp/checkout-sessions/{id}/complete      complete
 *   POST /{t}/ucp/checkout-sessions/{id}/cancel        cancel
 *   GET  /{t}/ucp/orders/{id}                          order view
 *   PUT  /{t}/ucp/orders/{id}                          order replace
 *   POST /{t}/testing/simulate-shipping/{order_id}     conformance hook (Simulation-Secret)
 *   POST /{t}/acp/checkout_sessions                    ACP create (Bearer key)
 *   GET/POST /{t}/acp/checkout_sessions/{id}[...]      ACP get/update/complete/cancel
 *   /bigcommerce/{auth,load,uninstall,settings}        BigCommerce app shell (bigcommerce-app.ts)
 *   /wix/{webhooks,dashboard,settings}                 Wix app shell (wix-app.ts)
 */

import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import * as acp from './acp.js';
import { verifyWixWebhookJwt } from './adapters/wix.js';
import { bigcommerceApp } from './bigcommerce-app.js';
import { orderIdByPlatformRef } from './db.js';
import { dispatch, type UcpOp, type UcpRequest } from './dispatcher.js';
import { markShipped, pushOrderUpdated, simulateShipping } from './orders.js';
import { businessProfile } from './profile.js';
import { tenantFor, type Tenant } from './tenants.js';
import { legalApp } from './legal.js';
import { handleWixEcomEvent, wixApp } from './wix-app.js';

const app = new Hono();

function tenantFrom(c: Context): Tenant | null {
  return tenantFor(c, c.req.param('tenant') ?? '');
}

async function ucpRequest(c: Context): Promise<UcpRequest> {
  const url = new URL(c.req.url);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    method: c.req.method,
    authority: headers['host'] ?? url.host,
    path: url.pathname,
    query: url.search.replace(/^\?/, ''),
    rawBody: ['GET', 'HEAD'].includes(c.req.method) ? '' : await c.req.text(),
    headers,
  };
}

const notFound = (c: Context) => c.json({ error: 'unknown tenant' }, 404);

function safeEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// -- profile ------------------------------------------------------------------

app.get('/:tenant/.well-known/ucp', async (c) => {
  const tenant = tenantFrom(c);
  if (!tenant) return notFound(c);
  if (!tenant.config.enabled) return c.json({ error: 'UCP is not enabled' }, 404);
  return c.json(await businessProfile(tenant));
});

app.get('/:tenant/.well-known/acp.json', (c) => {
  const tenant = tenantFrom(c);
  if (!tenant) return notFound(c);
  if (!tenant.config.enabled) return c.json({ error: 'ACP is not enabled' }, 404);
  return c.json(acp.discovery(tenant));
});

// -- UCP endpoints ---------------------------------------------------------------

function ucpRoute(op: UcpOp, idParam: string | null) {
  return async (c: Context) => {
    const tenant = tenantFrom(c);
    if (!tenant) return notFound(c);
    const req = await ucpRequest(c);
    const id = idParam ? c.req.param(idParam) : null;
    const [status, body] = await dispatch(tenant, op, req, id ?? null);
    return c.json(body, status as any);
  };
}

app.post('/:tenant/ucp/checkout-sessions', ucpRoute('create_checkout', null));
app.get('/:tenant/ucp/checkout-sessions/:id', ucpRoute('get_checkout', 'id'));
app.put('/:tenant/ucp/checkout-sessions/:id', ucpRoute('update_checkout', 'id'));
app.post('/:tenant/ucp/checkout-sessions/:id/complete', ucpRoute('complete_checkout', 'id'));
app.post('/:tenant/ucp/checkout-sessions/:id/cancel', ucpRoute('cancel_checkout', 'id'));
app.get('/:tenant/ucp/orders/:id', ucpRoute('get_order', 'id'));
app.put('/:tenant/ucp/orders/:id', ucpRoute('update_order', 'id'));

// -- conformance shipping simulation (Simulation-Secret gated) ----------------------

app.post('/:tenant/testing/simulate-shipping/:orderId', async (c) => {
  const tenant = tenantFrom(c);
  if (!tenant) return notFound(c);
  const secret = tenant.config.simulationSecret;
  if (!secret || !tenant.config.enabled) {
    return c.json({ error: 'simulation secret not configured' }, 500);
  }
  if (!safeEqual(secret, c.req.header('simulation-secret') ?? '')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const [status, body] = await simulateShipping(tenant, c.req.param('orderId'));
  return c.json(body, status as any);
});

// -- BigCommerce store webhooks -> UCP order webhooks ---------------------------------

// Registered on install with a custom X-Webhook-Secret header (bigcommerce-app.ts).
// Always 2xx so BigCommerce keeps the hook alive.
app.post('/:tenant/bigcommerce/webhooks', async (c) => {
  const tenant = tenantFrom(c);
  if (!tenant) return notFound(c);
  const secret = tenant.config.bigcommerceWebhookSecret;
  if (!secret || !safeEqual(secret, c.req.header('x-webhook-secret') ?? '')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const payload = await c.req.json().catch(() => null);
  const scope: string = payload?.scope ?? '';
  // Shipment scopes carry the order id as data.orderId; order scopes as data.id.
  const ref = String(payload?.data?.orderId ?? payload?.data?.id ?? '');
  const orderUuid = orderIdByPlatformRef(tenant.id, ref);
  if (orderUuid) {
    if (scope === 'store/shipment/created') await markShipped(tenant, orderUuid);
    else if (scope === 'store/order/statusUpdated') await pushOrderUpdated(tenant, orderUuid);
  }
  return c.json({ ok: true });
});

// -- Wix webhooks (signed JWT body) -> UCP order webhooks ------------------------------

// Per-tenant sink verified with the tenant's own public key (dev/legacy tenants).
// Installed apps use the app-level POST /wix/webhooks in wix-app.ts instead.
app.post('/:tenant/wix/webhooks', async (c) => {
  const tenant = tenantFrom(c);
  if (!tenant) return notFound(c);
  const pem = tenant.config.wixWebhookPublicKey;
  const event = pem ? verifyWixWebhookJwt(pem, await c.req.text()) : null;
  if (!event) return c.json({ error: 'forbidden' }, 403);
  await handleWixEcomEvent(tenant, event);
  return c.json({ ok: true });
});

// -- ACP endpoints -------------------------------------------------------------------

function acpRoute(op: acp.AcpOp, withId: boolean) {
  return async (c: Context) => {
    const tenant = tenantFrom(c);
    if (!tenant) return notFound(c);
    if (!tenant.config.enabled) return c.json({ error: 'ACP is not enabled' }, 404);
    const req = await ucpRequest(c);
    const id = withId ? c.req.param('id') : null;
    const res = await acp.dispatch(tenant, op, req, id ?? null);
    for (const [name, value] of Object.entries(res.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(res.body, res.status as any);
  };
}

app.post('/:tenant/acp/checkout_sessions', acpRoute('create', false));
app.get('/:tenant/acp/checkout_sessions/:id', acpRoute('get', true));
app.post('/:tenant/acp/checkout_sessions/:id', acpRoute('update', true));
app.post('/:tenant/acp/checkout_sessions/:id/complete', acpRoute('complete', true));
app.post('/:tenant/acp/checkout_sessions/:id/cancel', acpRoute('cancel', true));

app.route('/bigcommerce', bigcommerceApp);
app.route('/wix', wixApp);
app.route('/legal', legalApp);

app.get('/healthz', (c) => c.json({ ok: true }));

export { app };
