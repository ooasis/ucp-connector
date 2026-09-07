/**
 * UCP checkout sessions: protocol-native session documents with the
 * incomplete -> ready_for_complete -> completed/canceled state machine.
 * Port of the conformance-proven Magento Checkout model, with platform
 * concerns behind PlatformAdapter.
 */

import { randomUUID } from 'node:crypto';
import { adapterFor, type Destination } from './adapter.js';
import { getSession, saveSession } from './db.js';
import { UcpError } from './errors.js';
import { buildOrderEntity, sendUcpWebhook, storeOrder } from './orders.js';
import { charge } from './payments.js';
import { endpoint, fetchPlatformProfile, responseEnvelope, webhookUrlFromProfile } from './profile.js';
import type { Tenant } from './tenants.js';

// -- storage ------------------------------------------------------------------

/** Load a checkout session document or fail with 404. */
export function load(tenant: Tenant, id: string): any {
  const doc = getSession(tenant.id, id);
  if (!doc) throw new UcpError(404, 'RESOURCE_NOT_FOUND', 'Checkout session not found');
  return doc;
}

function save(tenant: Tenant, doc: any): void {
  saveSession(tenant.id, doc.id, doc);
}

// -- endpoints ------------------------------------------------------------------

/** Create a new checkout session document from the request body. */
export async function create(tenant: Tenant, body: any, ucpAgent: string): Promise<any> {
  const doc: any = {
    ucp: responseEnvelope(tenant),
    id: randomUUID(),
    status: 'incomplete',
    currency: tenant.config.currency,
    links: [],
    payment: { instruments: stripCredentials(body.payment?.instruments ?? []) },
  };
  if (body.buyer !== undefined) doc.buyer = body.buyer;
  doc.line_items = (body.line_items ?? []).map((li: any) => ({
    id: randomUUID(),
    item: { id: li.item?.id ?? '' },
    quantity: Math.trunc(li.quantity ?? 1),
  }));
  if (body.fulfillment?.methods?.length) {
    doc.fulfillment = { methods: body.fulfillment.methods.map(normalizeMethod) };
  }
  if (body.discounts?.codes?.length) {
    doc.discounts = { codes: [...body.discounts.codes] };
  }
  await attachWebhookUrl(tenant, doc, ucpAgent);
  await injectKnownAddresses(tenant, doc);
  await recalculate(tenant, doc);
  save(tenant, doc);
  return doc;
}

/** Apply partial updates to a session and recalculate it. */
export async function update(tenant: Tenant, id: string, body: any, ucpAgent: string): Promise<any> {
  const doc = load(tenant, id);
  assertModifiable(doc);
  if (body.line_items !== undefined) {
    doc.line_items = body.line_items.map((li: any) => ({
      id: li.id ?? randomUUID(),
      item: { id: li.item?.id ?? '' },
      quantity: Math.trunc(li.quantity ?? 1),
    }));
  }
  if (body.buyer !== undefined) doc.buyer = body.buyer;
  if (body.payment !== undefined) {
    doc.payment = { instruments: stripCredentials(body.payment.instruments ?? []) };
  }
  if (body.fulfillment !== undefined) {
    doc.fulfillment = mergeFulfillment(doc.fulfillment ?? { methods: [] }, body.fulfillment);
  }
  if (body.discounts !== undefined) {
    doc.discounts = { codes: [...(body.discounts.codes ?? [])] };
  }
  await attachWebhookUrl(tenant, doc, ucpAgent);
  await injectKnownAddresses(tenant, doc);
  await recalculate(tenant, doc);
  save(tenant, doc);
  return doc;
}

/** Mark a session as canceled. */
export function cancel(tenant: Tenant, id: string): any {
  const doc = load(tenant, id);
  assertModifiable(doc);
  doc.status = 'canceled';
  save(tenant, doc);
  return doc;
}

/** Charge the payment, materialize the platform order, mark the session completed. */
export async function complete(tenant: Tenant, id: string, body: any): Promise<any> {
  const doc = load(tenant, id);
  assertModifiable(doc);
  if (!isCompletable(doc)) {
    throw new UcpError(
      400,
      'INVALID_REQUEST',
      'Fulfillment address and option must be selected before completion',
      'requires_buyer_input',
    );
  }
  const instrument = body.payment?.instruments?.[0];
  if (!instrument || !instrument.handler_id || !instrument.credential) {
    throw new UcpError(400, 'INVALID_REQUEST', 'A payment instrument with handler_id and credential is required');
  }
  const adapter = adapterFor(tenant);
  // Re-check stock before charging so payment isn't taken for unfillable items.
  for (const li of doc.line_items) {
    const item = await adapter.getItem(tenant, li.item.id);
    if (!item) throw new UcpError(400, 'INVALID_REQUEST', `Product ${li.item.id} not found`);
    if (item.stock !== null && item.stock < li.quantity) {
      throw new UcpError(409, 'OUT_OF_STOCK', `Item ${li.item.id} is out of stock`);
    }
  }
  const total = totalOf(doc.totals);
  const transactionId = await charge(tenant, instrument, total, doc.currency);

  const orderUuid = randomUUID();
  const platformRef = await adapter.createOrder(tenant, doc, orderUuid, transactionId);
  const orderEntity = buildOrderEntity(tenant, doc, orderUuid);
  storeOrder(tenant, orderUuid, orderEntity, platformRef);

  doc.status = 'completed';
  doc.order = { id: orderUuid, permalink_url: `${endpoint(tenant)}/orders/${orderUuid}` };
  save(tenant, doc);
  await sendUcpWebhook(tenant, orderEntity, doc.platform?.webhook_url ?? null, 'order_placed');
  return doc;
}

/** Reject modification of completed or canceled sessions. */
function assertModifiable(doc: any): void {
  if (doc.status === 'completed' || doc.status === 'canceled') {
    throw new UcpError(409, 'CHECKOUT_NOT_MODIFIABLE', `Checkout is ${doc.status} and cannot be modified`);
  }
}

/** Spec: payment credentials must never be echoed back or persisted. */
function stripCredentials(instruments: any[]): any[] {
  return instruments.map(({ credential: _credential, ...rest }) => rest);
}

// -- recalculation pipeline -------------------------------------------------------

/** Recompute line items, fulfillment options, discounts, and totals in place. */
async function recalculate(tenant: Tenant, doc: any): Promise<void> {
  const adapter = adapterFor(tenant);
  let subtotal = 0;
  for (const li of doc.line_items) {
    const item = await adapter.getItem(tenant, li.item.id);
    if (!item) throw new UcpError(400, 'INVALID_REQUEST', `Product ${li.item.id} not found`);
    if (item.stock !== null && item.stock < li.quantity) {
      throw new UcpError(400, 'OUT_OF_STOCK', `Insufficient stock for item ${li.item.id}`);
    }
    li.item = { id: item.id, title: item.title, price: item.price };
    const lineTotal = item.price * li.quantity;
    li.totals = [
      { type: 'subtotal', amount: lineTotal },
      { type: 'total', amount: lineTotal },
    ];
    subtotal += lineTotal;
  }

  const totals: any[] = [{ type: 'subtotal', amount: subtotal }];
  let fulfillmentTotal = 0;
  if (doc.fulfillment?.methods?.length) {
    for (const method of doc.fulfillment.methods) {
      await recomputeOptions(tenant, method, subtotal, doc.line_items);
      for (const group of method.groups ?? []) {
        if (!group.selected_option_id) continue;
        for (const opt of group.options ?? []) {
          if (opt.id === group.selected_option_id) {
            const amount = totalOf(opt.totals);
            totals.push({ type: 'fulfillment', amount });
            fulfillmentTotal += amount;
          }
        }
      }
    }
  }

  // Discounts: sequential on the shrinking (subtotal + fulfillment) base.
  let running = subtotal + fulfillmentTotal;
  let runningItems = subtotal; // for platforms whose coupons never touch shipping (Wix)
  const applied: any[] = [];
  for (const code of doc.discounts?.codes ?? []) {
    const discount = await adapter.validateDiscount(tenant, code);
    if (discount === null) continue; // unknown codes are silently ignored
    const base = discount.appliesTo === 'items' ? runningItems : running;
    const amount =
      discount.type === 'percentage'
        ? Math.trunc((base * discount.value) / 100)
        : Math.min(base, discount.value);
    if (amount <= 0) continue;
    running -= amount;
    runningItems = Math.max(0, runningItems - amount);
    applied.push({
      code: discount.code,
      title: discount.title,
      amount,
      allocations: [{ path: "$.totals[?(@.type=='subtotal')]", amount }],
    });
    totals.push({ type: 'discount', amount: -amount });
  }
  if (doc.discounts !== undefined) doc.discounts.applied = applied;

  totals.push({
    type: 'total',
    amount: totals.reduce((sum, t) => (t.type === 'total' ? sum : sum + t.amount), 0),
  });
  doc.totals = totals;
  doc.status = isCompletable(doc) ? 'ready_for_complete' : 'incomplete';
}

/** Whether a fulfillment destination and option have been selected for completion. */
export function isCompletable(doc: any): boolean {
  if (!doc.line_items?.length) return false;
  for (const method of doc.fulfillment?.methods ?? []) {
    if ((method.type ?? 'shipping') === 'shipping' && !method.selected_destination_id) continue;
    for (const group of method.groups ?? []) {
      if (group.selected_option_id) return true;
    }
  }
  return false;
}

/** Extract the 'total' amount from a totals list. */
export function totalOf(totals: any[]): number {
  for (const t of totals ?? []) {
    if (t.type === 'total') return t.amount;
  }
  return 0;
}

// -- fulfillment ---------------------------------------------------------------------

/** Normalize an incoming fulfillment method to the response shape. */
function normalizeMethod(m: any): any {
  const method: any = {
    id: m.id ?? `method_${randomUUID()}`,
    type: m.type ?? 'shipping',
    line_item_ids: [...(m.line_item_ids ?? [])],
  };
  if (m.destinations !== undefined) {
    method.destinations = m.destinations.map(normalizeDestination);
  }
  method.selected_destination_id = m.selected_destination_id ?? null;
  if (m.groups !== undefined) {
    method.groups = m.groups.map((g: any) => ({
      id: g.id ?? `group_${randomUUID()}`,
      line_item_ids: [...(g.line_item_ids ?? [])],
      selected_option_id: g.selected_option_id ?? null,
    }));
  }
  return method;
}

/** Accept SDK aliases (locality/region) and emit the response shape. */
function normalizeDestination(d: any): Destination {
  const out: Destination = {
    id: d.id ?? `dest_${randomUUID()}`,
    type: 'shipping_address',
    street_address: d.street_address ?? '',
    address_locality: d.address_locality ?? d.locality ?? '',
    address_region: d.address_region ?? d.region ?? '',
    postal_code: d.postal_code ?? '',
    address_country: d.address_country ?? '',
  };
  for (const extra of ['full_name', 'first_name', 'last_name', 'phone_number', 'extended_address']) {
    if (d[extra] !== undefined) out[extra] = d[extra];
  }
  return out;
}

/** Hierarchical merge per the spec: match methods by id, replace-if-sent per field. */
function mergeFulfillment(existing: any, incoming: any): any {
  const result: any = { methods: [] };
  const existingMethods = existing.methods ?? [];
  for (const incomingMethod of incoming.methods ?? []) {
    let match: any = null;
    for (const ex of existingMethods) {
      if (incomingMethod.id !== undefined && ex.id === incomingMethod.id) match = ex;
    }
    if (match === null && incomingMethod.id === undefined && existingMethods.length === 1) {
      match = existingMethods[0];
    }
    const normalized = normalizeMethod(incomingMethod);
    if (match) {
      normalized.id = match.id;
      if (incomingMethod.destinations === undefined) {
        normalized.destinations = match.destinations ?? [];
      }
      if (incomingMethod.groups === undefined && match.groups !== undefined) {
        normalized.groups = match.groups;
      }
      if (!normalized.line_item_ids.length) {
        normalized.line_item_ids = match.line_item_ids;
      }
    }
    result.methods.push(normalized);
  }
  return result;
}

/** Compute shipping options for a method's selected destination via the adapter. */
async function recomputeOptions(
  tenant: Tenant,
  method: any,
  subtotal: number,
  lineItems: any[],
): Promise<void> {
  if ((method.type ?? 'shipping') !== 'shipping' || !method.selected_destination_id) return;
  const dest = (method.destinations ?? []).find((d: any) => d.id === method.selected_destination_id);
  if (!dest) return;
  const items = lineItems.map((li) => ({ id: li.item.id, quantity: li.quantity }));
  const rates = await adapterFor(tenant).shippingOptions(tenant, dest, subtotal, items);
  const options = rates
    .map((r) => ({
      id: r.id,
      title: r.title,
      totals: [
        { type: 'subtotal', amount: r.amount },
        { type: 'total', amount: r.amount },
      ],
    }))
    .sort((a, b) => totalOf(a.totals) - totalOf(b.totals));

  if (!method.groups?.length) {
    method.groups = [
      { id: `group_${randomUUID()}`, line_item_ids: method.line_item_ids, selected_option_id: null },
    ];
  }
  for (const group of method.groups) {
    group.options = options;
  }
}

/** Known-customer address injection: platform buyer matched by email. */
async function injectKnownAddresses(tenant: Tenant, doc: any): Promise<void> {
  const email = doc.buyer?.email;
  if (!email || !doc.fulfillment?.methods?.length) return;
  const stored = await adapterFor(tenant).customerAddresses(tenant, email);
  if (stored === null) return;
  for (const method of doc.fulfillment.methods) {
    if ((method.type ?? 'shipping') !== 'shipping') continue;
    if (!method.destinations?.length) {
      if (stored.length) method.destinations = [...stored];
    } else {
      adoptStoredAddressIds(method, stored);
    }
  }
}

/** Content-duplicate destinations adopt the stored customer address id. */
function adoptStoredAddressIds(method: any, stored: Destination[]): void {
  for (const d of method.destinations) {
    for (const s of stored) {
      if (s.street_address === d.street_address && s.postal_code === d.postal_code) {
        if ((method.selected_destination_id ?? null) === d.id) {
          method.selected_destination_id = s.id;
        }
        d.id = s.id;
      }
    }
  }
}

/** Attach the webhook URL discovered from the agent's UCP platform profile. */
async function attachWebhookUrl(tenant: Tenant, doc: any, ucpAgent: string): Promise<void> {
  const url = webhookUrlFromProfile(await fetchPlatformProfile(tenant, ucpAgent));
  if (url) doc.platform = { webhook_url: url };
}
