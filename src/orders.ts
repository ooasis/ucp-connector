/**
 * UCP order entities: build from a completed checkout, store, replace (PUT),
 * shipping simulation for the conformance suite, and signed push webhooks.
 * Port of the Magento Orders model.
 */

import { randomUUID } from 'node:crypto';
import { sendAcpOrderWebhook } from './acp.js';
import { getOrder, getSession, saveOrder } from './db.js';
import { UcpError } from './errors.js';
import { contentDigest, signatureBase, type Jwk } from './rfc9421.js';
import { signBase } from './rfc9421.js';
import { endpoint, isPublicUrl, VERSION } from './profile.js';
import { privateJwk, publicJwk, type Tenant } from './tenants.js';

// -- entity --------------------------------------------------------------------

/** Build the UCP order entity from a completed checkout doc. */
export function buildOrderEntity(tenant: Tenant, doc: any, orderUuid: string): any {
  const lineItems = doc.line_items.map((li: any) => ({
    id: li.id,
    item: li.item,
    quantity: { total: li.quantity, fulfilled: 0 },
    totals: li.totals,
    status: 'processing',
  }));

  const expectations: any[] = [];
  for (const method of doc.fulfillment?.methods ?? []) {
    const dest = (method.destinations ?? []).find(
      (d: any) => d.id === (method.selected_destination_id ?? null),
    );
    for (const group of method.groups ?? []) {
      if (!group.selected_option_id) continue;
      const title = (group.options ?? []).find((o: any) => o.id === group.selected_option_id)?.title;
      // Expectation line items: checkout items matching the group ids,
      // falling back to all items (group ids may reference client-side ids).
      let items = doc.line_items.filter((li: any) => (group.line_item_ids ?? []).includes(li.id));
      if (!items.length) items = doc.line_items;
      const exp: any = {
        id: `exp_${randomUUID()}`,
        line_items: items.map((li: any) => ({ id: li.id, quantity: li.quantity })),
        method_type: method.type ?? 'shipping',
        description: title ?? null,
      };
      if (dest) {
        const { id: _id, type: _type, ...destination } = dest;
        exp.destination = destination;
      }
      expectations.push(exp);
    }
  }

  return {
    ucp: {
      version: VERSION,
      capabilities: {
        'dev.ucp.shopping.checkout': [
          { name: 'dev.ucp.shopping.checkout', version: VERSION },
        ],
      },
    },
    id: orderUuid,
    checkout_id: doc.id,
    permalink_url: `${endpoint(tenant)}/orders/${orderUuid}`,
    currency: doc.currency,
    totals: doc.totals,
    line_items: lineItems,
    fulfillment: { expectations, events: [] },
  };
}

// -- storage ---------------------------------------------------------------------

export function storeOrder(tenant: Tenant, orderUuid: string, entity: any, platformRef = ''): void {
  saveOrder(tenant.id, orderUuid, entity, platformRef);
}

/** Load a stored order entity, throwing a 404 UcpError when unknown. */
export function loadOrder(tenant: Tenant, orderUuid: string): any {
  const entity = getOrder(tenant.id, orderUuid);
  if (!entity) throw new UcpError(404, 'RESOURCE_NOT_FOUND', 'Order not found');
  return entity;
}

/** Replace (PUT) a stored order entity after shape validation. */
export function replaceOrder(tenant: Tenant, orderUuid: string, body: any): any {
  loadOrder(tenant, orderUuid); // 404 when unknown
  validateEntity(body);
  storeOrder(tenant, orderUuid, body);
  return body;
}

/** Minimal shape validation for PUT — bad enums/containers must 422. */
function validateEntity(e: any): void {
  const requiredFields = [
    'ucp', 'id', 'checkout_id', 'permalink_url', 'line_items', 'fulfillment', 'currency', 'totals',
  ];
  for (const k of requiredFields) {
    if (e[k] === undefined) throw new UcpError(422, 'INVALID_REQUEST', `Order field ${k} is required`);
  }
  if (e.adjustments !== undefined) {
    if (!Array.isArray(e.adjustments)) {
      throw new UcpError(422, 'INVALID_REQUEST', 'adjustments must be a list');
    }
    for (const adj of e.adjustments) {
      if (adj.status !== undefined && !['pending', 'completed', 'failed'].includes(adj.status)) {
        throw new UcpError(422, 'INVALID_REQUEST', 'Invalid adjustment status');
      }
    }
  }
  if (e.fulfillment?.events !== undefined && !Array.isArray(e.fulfillment.events)) {
    throw new UcpError(422, 'INVALID_REQUEST', 'fulfillment.events must be a list');
  }
}

// -- shipping simulation (conformance test hook) --------------------------------------

/** Mark every line item shipped and push the order_shipped webhook. */
export async function simulateShipping(tenant: Tenant, orderUuid: string): Promise<[number, any]> {
  try {
    loadOrder(tenant, orderUuid);
  } catch {
    return [404, { error: 'order not found' }];
  }
  await markShipped(tenant, orderUuid);
  return [200, { status: 'shipped' }];
}

/** Append a shipped event to the order and push order_shipped (UCP + ACP). */
export async function markShipped(tenant: Tenant, orderUuid: string): Promise<void> {
  const entity = loadOrder(tenant, orderUuid);
  entity.fulfillment.events.push({
    id: `evt_${randomUUID()}`,
    type: 'shipped',
    occurred_at: new Date().toISOString(),
    line_items: entity.line_items.map((li: any) => ({ id: li.id, quantity: li.quantity.total })),
  });
  storeOrder(tenant, orderUuid, entity);
  await pushEntity(tenant, entity, 'order_shipped');
  await sendAcpOrderWebhook(tenant, orderUuid, 'order_update');
}

/** Re-push the stored order entity as an order_updated event (UCP + ACP). */
export async function pushOrderUpdated(tenant: Tenant, orderUuid: string): Promise<void> {
  await pushEntity(tenant, loadOrder(tenant, orderUuid), 'order_updated');
  await sendAcpOrderWebhook(tenant, orderUuid, 'order_update');
}

/** Webhook target: the checkout that produced this order knows the platform URL. */
async function pushEntity(tenant: Tenant, entity: any, eventType: string): Promise<void> {
  const doc = getSession(tenant.id, entity.checkout_id);
  await sendUcpWebhook(tenant, entity, doc?.platform?.webhook_url ?? null, eventType);
}

// -- webhooks ---------------------------------------------------------------------------

/**
 * POST the full order entity to the platform, signed per RFC 9421.
 * Retries up to 3 times on transport error / 5xx with the same Webhook-Id,
 * Webhook-Timestamp, and body.
 */
export async function sendUcpWebhook(
  tenant: Tenant,
  entity: any,
  url: string | null,
  eventType: string,
): Promise<void> {
  if (!url) return;
  // Platform-supplied URL: refuse private/internal targets (SSRF) outside test mode.
  if (!tenant.config.simulationSecret && !(await isPublicUrl(url))) return;
  const body = JSON.stringify(entity);
  const webhookId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  let authority = '';
  let path = '/';
  try {
    const parsed = new URL(url);
    authority = parsed.host; // URL omits default ports per RFC 3986
    path = parsed.pathname || '/';
  } catch {
    /* keep fallbacks */
  }
  const ucpAgent = `profile="${tenant.baseUrl}/.well-known/ucp"`;
  const digest = contentDigest(body);

  const key: Jwk = await privateJwk(tenant.id);
  const kid = (await publicJwk(tenant.id)).kid;
  const components = ['@method', '@authority', '@path', 'content-digest', 'content-type',
                      'ucp-agent', 'webhook-id', 'webhook-timestamp', 'x-event-type'];
  const params = `;keyid="${kid}"`;
  const base = signatureBase(
    components,
    { method: 'POST', authority, path },
    {
      'content-digest': digest,
      'content-type': 'application/json',
      'ucp-agent': ucpAgent,
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'x-event-type': eventType,
    },
    params,
  );
  const list = components.map((c) => `"${c}"`).join(' ');

  const headers = {
    'Content-Type': 'application/json',
    'X-Event-Type': eventType,
    'Webhook-Id': webhookId,
    'Webhook-Timestamp': timestamp,
    'Idempotency-Key': webhookId,
    'UCP-Agent': ucpAgent,
    'Content-Digest': digest,
    'Signature-Input': `sig1=(${list})${params}`,
    Signature: 'sig1=:' + Buffer.from(await signBase(base, key)).toString('base64') + ':',
  };

  for (let attempt = 0, delay = 500; attempt < 3; attempt++, delay *= 2) {
    try {
      // redirect: 'manual' — a 3xx could bounce past the isPublicUrl check (SSRF);
      // treat it as a permanent delivery failure.
      const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      // Delivered (2xx) or permanent failure (3xx/4xx) — no retry.
      if (res.status < 500) return;
    } catch {
      /* transport error: retry after backoff */
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  // ponytail: in-request retry loop blocks the caller up to ~1.5s+timeouts;
  // move to queued delivery when real traffic arrives.
}
