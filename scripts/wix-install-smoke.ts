/**
 * Wix app-shell smoke (plan phase 5): boots the connector in-process against
 * the running mock Wix API (npm run mock:wix, :8789) and drives the app-level
 * webhook sink (AppInstalled -> tenant, eCom fulfillment event -> shipped,
 * AppRemoved -> disabled), the signed-instance dashboard page, the settings
 * form, a checkout on the installed tenant, and install-on-dashboard-open for
 * a missed install webhook. Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';
import { createHmac, createPublicKey, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = process.env.WIX_MOCK_BASE ?? 'http://localhost:8789';
const APP_ID = 'mock-wix-app-id';
const APP_SECRET = 'mock-wix-app-secret';
// The mock signs webhooks with dev/mock-wix/webhook-key.pem; the app verifies with its public half.
const PUBLIC_KEY = createPublicKey(readFileSync(join(ROOT, 'dev', 'mock-wix', 'webhook-key.pem')))
  .export({ type: 'spki', format: 'pem' })
  .toString();

process.env.UCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ucp-wix-install-smoke-'));
process.env.UCP_NO_LISTEN = '1';
process.env.WIX_APP_ID = APP_ID;
process.env.WIX_APP_SECRET = APP_SECRET;
process.env.WIX_APP_PUBLIC_KEY = PUBLIC_KEY;
process.env.WIX_API_BASE = MOCK;

const mockUp = await fetch(`${MOCK}/_orders`).then((r) => r.ok).catch(() => false);
if (!mockUp) {
  console.error(`mock Wix not reachable at ${MOCK} — run: npm run mock:wix`);
  process.exit(2);
}

const { app } = await import('../src/index.js');
const { serve } = await import('@hono/node-server');
const { loadTenantConfig } = await import('../src/tenants.js');

const server = serve({ fetch: app.fetch, port: 0 });
const port: number = (server.address() as any).port;
const origin = `http://localhost:${port}`;
const INSTANCE = randomUUID();

let step = 0;
const ok = (msg: string) => console.log(`  ${String(++step).padStart(2)}. ${msg}`);

/** Have the mock sign + deliver a Wix webhook JWT to our app-level sink. */
const emit = (eventType: string, extra: Record<string, any> = {}) =>
  fetch(`${MOCK}/_emit-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${origin}/wix/webhooks`, eventType, instanceId: INSTANCE, ...extra }),
  }).then((r) => (r.json() as Promise<any>));

/** Wix dashboard `instance` parameter: base64url(hmac).base64url(json). */
function signedInstance(instanceId: string, secret = APP_SECRET): string {
  const data = Buffer.from(
    JSON.stringify({ instanceId, signDate: new Date().toISOString(), uid: 'owner', permissions: 'OWNER' }),
  ).toString('base64url');
  return `${createHmac('sha256', secret).update(data).digest('base64url')}.${data}`;
}

const tokenOf = (page: string): string => {
  const m = /name="token" value="([^"]+)"/.exec(page);
  assert.ok(m, 'settings page carries a session token');
  return m[1];
};

const postSettings = (token: string, fields: Record<string, string>) =>
  fetch(`${origin}/wix/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, ...fields }),
  });

try {
  console.log(`wix install smoke: instance ${INSTANCE} via ${MOCK}`);

  // -- install via webhook ----------------------------------------------------------------
  let delivered = await emit('AppInstalled');
  assert.equal(delivered.delivered, 200);
  let cfg = loadTenantConfig(INSTANCE)!;
  assert.ok(cfg, 'tenant created');
  assert.equal(cfg.adapter, 'wix');
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.wixInstanceId, INSTANCE);
  assert.equal(cfg.wixSiteId, 'mock-site');
  assert.equal(cfg.merchantName, 'Mock Wix Flower Shop');
  assert.equal(cfg.wixSiteUrl, 'https://mock-site.wixsite.com/flowers');
  assert.equal(cfg.wixAccessToken, '', 'no static token stored: instance tokens are minted on demand');
  ok('AppInstalled webhook: tenant created, site info from Get App Instance');

  const profile = await fetch(`${origin}/${INSTANCE}/.well-known/ucp`);
  assert.equal(profile.status, 200);
  assert.equal(
    (await (profile.json() as Promise<any>)).ucp.services['dev.ucp.shopping'][0].endpoint,
    `${origin}/${INSTANCE}/ucp`,
  );
  ok('hosted profile served for the instance');

  const bad = await fetch(`${origin}/wix/webhooks`, { method: 'POST', body: 'garbage.jwt.here' });
  assert.equal(bad.status, 403);
  ok('webhook sink: unsigned payload -> 403');

  // -- dashboard ------------------------------------------------------------------------------
  let res = await fetch(`${origin}/wix/dashboard?instance=${signedInstance(INSTANCE)}`);
  assert.equal(res.status, 200);
  let page = await res.text();
  assert.match(page, /Enable UCP endpoints/);
  assert.match(page, /mock-site\.wixsite\.com\/flowers\/\.well-known\/ucp/);
  assert.doesNotMatch(page, /Installed\./);
  ok('dashboard: signed instance renders settings with .well-known instructions');

  for (const forged of [signedInstance(INSTANCE, 'wrong'), 'garbage', `x.${Buffer.from('{}').toString('base64url')}`]) {
    res = await fetch(`${origin}/wix/dashboard?instance=${forged}`);
    assert.equal(res.status, 401);
  }
  ok('dashboard: bad signature / garbage -> 401');

  // -- settings ---------------------------------------------------------------------------------
  res = await postSettings(tokenOf(page), {
    enabled: 'on',
    stripeSecretKey: 'sk_test_wix_1234',
    stripePublishableKey: 'pk_test_wix',
    simulationSecret: 'wix-smoke-secret',
  });
  assert.equal(res.status, 200);
  page = await res.text();
  assert.match(page, /Settings saved\./);
  assert.doesNotMatch(page, /sk_test_wix_1234/);
  cfg = loadTenantConfig(INSTANCE)!;
  assert.equal(cfg.stripeSecretKey, 'sk_test_wix_1234');
  assert.equal(cfg.simulationSecret, 'wix-smoke-secret');
  ok('settings saved; secrets masked in HTML');

  res = await postSettings(tokenOf(page), { enabled: 'on', stripePublishableKey: 'pk_test_wix' });
  cfg = loadTenantConfig(INSTANCE)!;
  assert.equal(cfg.stripeSecretKey, 'sk_test_wix_1234');
  ok('blank secret fields keep the stored values');

  assert.equal((await postSettings('forged.token.here', { enabled: 'on' })).status, 401);
  ok('settings: forged session token -> 401');

  // -- checkout on the installed tenant -----------------------------------------------------
  const base = `${origin}/${INSTANCE}`;
  const create = await fetch(`${base}/ucp/checkout-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      line_items: [{ item: { id: 'bouquet_roses' }, quantity: 2 }],
      buyer: { first_name: 'Smoke', last_name: 'Test', email: 'smoke@example.com' },
      fulfillment: {
        methods: [
          {
            type: 'shipping',
            destinations: [
              {
                id: 'dest1',
                street_address: '1 Main St',
                address_locality: 'Chicago',
                address_region: 'IL',
                postal_code: '60601',
                address_country: 'US',
              },
            ],
            selected_destination_id: 'dest1',
          },
        ],
      },
    }),
  });
  assert.equal(create.status, 201);
  const session = await (create.json() as Promise<any>);
  const method = session.fulfillment.methods[0];
  const optionId = method.groups[0].options[0].id;
  const update = await fetch(`${base}/ucp/checkout-sessions/${session.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      fulfillment: {
        methods: [
          {
            ...method,
            selected_destination_id: 'dest1',
            groups: [{ ...method.groups[0], selected_option_id: optionId }],
          },
        ],
      },
    }),
  }).then((r) => (r.json() as Promise<any>));
  assert.equal(update.status, 'ready_for_complete');
  const complete = await fetch(`${base}/ucp/checkout-sessions/${session.id}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      payment: {
        instruments: [
          {
            id: 'pi1',
            handler_id: 'mock_payment_handler',
            type: 'card',
            credential: { type: 'token', token: 'success_token' },
          },
        ],
      },
    }),
  });
  assert.equal(complete.status, 200);
  const done = await (complete.json() as Promise<any>);
  assert.equal(done.status, 'completed');
  ok(`checkout on the instance with a client_credentials token: order ${done.order.id}`);

  // Wix's own PENDING gateway placeholder is voided in the background after Add Payments.
  let statuses: string[] = [];
  for (let i = 0; i < 10 && !statuses.includes('VOIDED'); i++) {
    await new Promise((r) => setTimeout(r, 200));
    const wo = ((await (fetch(`${MOCK}/_orders`).then((r) => (r.json() as Promise<any>)))) as any[])
      .reverse()
      .find((o) => o.buyerInfo?.email === 'smoke@example.com');
    statuses = (wo?.payments ?? []).map((p: any) => p.regularPaymentDetails?.status ?? p.status);
  }
  assert.deepEqual([...statuses].sort(), ['APPROVED', 'VOIDED'], `payments: ${statuses}`);
  ok('our payment APPROVED, Wix gateway placeholder VOIDED (one live payment line)');

  const wixOrders = (await fetch(`${MOCK}/_orders`).then((r) => (r.json() as Promise<any>))) as any[];
  // Mock state outlives smoke runs: take the newest PAID order for this buyer.
  // (paymentStatus settles asynchronously on Wix, so do not filter on it.)
  const placed = [...wixOrders].reverse().find((o) => o.buyerInfo?.email === 'smoke@example.com');
  assert.ok(placed, 'Wix order PAID');
  delivered = await emit('wix.ecom.v1.fulfillments_updated', { orderId: placed.id });
  assert.equal(delivered.delivered, 200);
  await emit('wix.ecom.v1.fulfillments_updated', { orderId: placed.id }); // Wix re-sends on every change
  const entity = await (fetch(`${base}/ucp/orders/${done.order.id}`).then((r) => (r.json() as Promise<any>)));
  const shippedEvents = (entity.fulfillment?.events ?? []).filter((e: any) => e.type === 'shipped');
  assert.equal(shippedEvents.length, 1, 'exactly one shipped event despite repeated fulfillment webhooks');
  ok('fulfillments_updated webhook (real shape) via the app-level sink -> one shipped event');

  // -- remove / reinstall ---------------------------------------------------------------------
  await emit('AppRemoved');
  cfg = loadTenantConfig(INSTANCE)!;
  assert.equal(cfg.enabled, false);
  assert.equal((await fetch(`${origin}/${INSTANCE}/.well-known/ucp`)).status, 404);
  ok('AppRemoved: tenant disabled, profile 404');

  await emit('AppInstalled');
  cfg = loadTenantConfig(INSTANCE)!;
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.stripeSecretKey, 'sk_test_wix_1234');
  ok('reinstall: re-enabled, settings kept');

  // -- missed install webhook: dashboard open installs ---------------------------------------
  const other = randomUUID();
  res = await fetch(`${origin}/wix/dashboard?instance=${signedInstance(other)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Installed\./);
  assert.equal(loadTenantConfig(other)?.enabled, true);
  ok('unknown instance opening the dashboard gets installed on the spot');

  console.log(`wix install smoke: ${step}/${step} green`);
} catch (e) {
  console.error('wix install smoke FAILED at step', step + 1);
  console.error(e);
  process.exitCode = 1;
} finally {
  server.close();
}
