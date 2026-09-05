/**
 * ACP (OpenAI Agentic Commerce Protocol, v2026-04-17) dual-protocol layer.
 *
 * A translation shim over the same checkout core that serves UCP: ACP requests
 * are mapped onto checkout operations, and the stored (UCP-shaped) session
 * document is mapped back into the ACP CheckoutSession wire shape. One session
 * store, one state machine, two protocols. Port of the Woo UCPWC_Acp shim.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import * as checkout from './checkout.js';
import { hash, type UcpRequest } from './dispatcher.js';
import { idempotencyCheck, idempotencyStore } from './db.js';
import { UcpError } from './errors.js';
import { loadOrder } from './orders.js';
import { acpHandlers, isKnownHandler } from './payments.js';
import { acpApiKey, type Tenant } from './tenants.js';

export const ACP_VERSION = '2026-04-17';

export type AcpOp = 'create' | 'get' | 'update' | 'complete' | 'cancel';

export type AcpResult = { status: number; body: any; headers?: Record<string, string> };

/** Served at /{tenant}/.well-known/acp.json */
export function discovery(tenant: Tenant): any {
  return {
    protocol: { version: ACP_VERSION },
    api_base_url: `${tenant.baseUrl}/acp`,
    transports: ['rest'],
    capabilities: ['checkout', 'orders_webhooks'],
  };
}

// -- request pipeline ---------------------------------------------------------------

export async function dispatch(
  tenant: Tenant,
  op: AcpOp,
  req: UcpRequest,
  id: string | null,
): Promise<AcpResult> {
  try {
    const auth = req.headers['authorization'] ?? '';
    const expected = `Bearer ${acpApiKey(tenant.id)}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length !== expectedBuf.length || !timingSafeEqual(authBuf, expectedBuf)) {
      return error(401, 'invalid_request', 'invalid_api_key', 'Invalid or missing API key');
    }
    const ver = req.headers['api-version'];
    if (ver && ver !== ACP_VERSION) {
      const res = error(400, 'invalid_request', 'unsupported_api_version', `API version ${ver} is not supported`);
      res.body.supported_versions = [ACP_VERSION];
      return res;
    }
    let json: any = {};
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === 'object') json = parsed;
    } catch {
      /* empty/invalid body treated as {} */
    }

    if (op !== 'get') {
      const idemKey = req.headers['idempotency-key'];
      if (!idemKey) {
        return error(400, 'invalid_request', 'idempotency_key_required', 'Idempotency-Key header is required');
      }
      const requestHash = hash(`acp_${op}`, id, req.rawBody);
      const stored = idempotencyCheck(tenant.id, idemKey, requestHash);
      if (stored !== null) {
        if ('conflict' in stored) {
          return error(422, 'invalid_request', 'idempotency_conflict', 'Idempotency key reused with different parameters');
        }
        return finish({ status: stored.status, body: stored.body, headers: { 'Idempotent-Replayed': 'true' } }, req);
      }
      const res = await execute(tenant, op, json, id);
      if (res.status < 500) {
        idempotencyStore(tenant.id, idemKey, requestHash, res.status, res.body);
      }
      return finish(res, req);
    }
    return finish(await execute(tenant, op, json, id), req);
  } catch (e) {
    if (e instanceof UcpError) return finish(translateError(op, e), req);
    return finish(
      error(500, 'processing_error', 'internal_error', e instanceof Error ? e.message : String(e)),
      req,
    );
  }
}

function finish(res: AcpResult, req: UcpRequest): AcpResult {
  const rid = req.headers['request-id'];
  if (rid) res.headers = { ...res.headers, 'Request-Id': rid };
  return res;
}

async function execute(tenant: Tenant, op: AcpOp, json: any, id: string | null): Promise<AcpResult> {
  switch (op) {
    case 'create': {
      const doc = await checkout.create(tenant, toUcpRequest(json), '');
      return { status: 201, body: toAcpSession(tenant, doc) };
    }
    case 'get':
      return { status: 200, body: toAcpSession(tenant, checkout.load(tenant, id!)) };
    case 'update': {
      const doc = await checkout.update(tenant, id!, toUcpRequest(json, checkout.load(tenant, id!)), '');
      return { status: 200, body: toAcpSession(tenant, doc) };
    }
    case 'complete':
      return complete(tenant, id!, json);
    case 'cancel':
      return { status: 200, body: toAcpSession(tenant, checkout.cancel(tenant, id!)) };
  }
}

async function complete(tenant: Tenant, id: string, json: any): Promise<AcpResult> {
  const pd = json.payment_data;
  if (!pd) {
    return error(400, 'invalid_request', 'missing', 'payment_data is required', '$.payment_data');
  }
  // 2026-04-17 shape: handler_id + instrument.credential.token.
  // Legacy (≤2025-12-12) {token, provider} accepted for compatibility.
  const token = pd.instrument?.credential?.token ?? pd.token ?? '';
  let handler = pd.handler_id ?? '';
  if (!isKnownHandler(handler)) {
    // Legacy {token, provider: stripe} means an SPT; otherwise fall back to mock.
    handler =
      (pd.provider ?? '') === 'stripe' && tenant.config.stripeSecretKey
        ? 'card_tokenized'
        : 'mock_payment_handler';
  }
  const ucpBody: any = {
    payment: {
      instruments: [
        {
          id: 'acp_instr_1',
          handler_id: handler,
          type: pd.instrument?.type ?? 'card',
          credential: { type: pd.instrument?.credential?.type ?? 'token', token },
        },
      ],
    },
    risk_signals: json.risk_signals ?? [],
  };
  if (pd.billing_address !== undefined) {
    ucpBody.payment.instruments[0].billing_address = toUcpAddress(pd.billing_address);
  }
  let doc: any;
  try {
    doc = await checkout.complete(tenant, id, ucpBody);
  } catch (e) {
    if (
      e instanceof UcpError &&
      ['INSUFFICIENT_FUNDS', 'UNKNOWN_TOKEN', 'FRAUD_DETECTED', 'PAYMENT_DECLINED'].includes(e.ucpCode)
    ) {
      // ACP prefers business failures in-band: 200 session + error message.
      const session = toAcpSession(tenant, checkout.load(tenant, id));
      session.messages.push({
        type: 'error',
        code: 'payment_declined',
        content_type: 'plain',
        content: e.content,
      });
      return { status: 200, body: session };
    }
    throw e;
  }
  await sendAcpOrderWebhook(tenant, doc.order.id, 'order_create');
  return { status: 200, body: toAcpSession(tenant, doc) };
}

// -- ACP -> UCP request translation ---------------------------------------------------

function toUcpRequest(acp: any, existing: any = {}): any {
  const ucp: any = {};
  if (acp.line_items !== undefined) {
    ucp.line_items = acp.line_items.map((li: any) => ({
      item: { id: li.item?.id ?? li.id ?? '' },
      quantity: Math.trunc(li.quantity ?? 1), // Item has no quantity in 2026-04-17; default 1
    }));
  }
  if (acp.buyer !== undefined) ucp.buyer = acp.buyer;
  const codes = acp.discounts?.codes ?? acp.coupons ?? null; // coupons[] deprecated
  if (codes !== null) ucp.discounts = { codes: [...codes] };
  if (acp.fulfillment_details !== undefined || acp.selected_fulfillment_options !== undefined) {
    const method: any = { id: 'acp', type: 'shipping', line_item_ids: [] };
    const exMethod = existing.fulfillment?.methods?.[0] ?? null;
    if (acp.fulfillment_details?.address !== undefined) {
      const dest: any = toUcpAddress(acp.fulfillment_details.address);
      dest.id = 'acp_dest';
      if (acp.fulfillment_details.name !== undefined) {
        dest.full_name = acp.fulfillment_details.name;
      }
      method.destinations = [dest];
      method.selected_destination_id = 'acp_dest';
    } else if (exMethod) {
      method.destinations = exMethod.destinations ?? [];
      method.selected_destination_id = exMethod.selected_destination_id ?? null;
    }
    const selected =
      acp.selected_fulfillment_options?.[0]?.option_id ??
      exMethod?.groups?.[0]?.selected_option_id ??
      null;
    if (exMethod || selected) {
      method.groups = [
        {
          id: exMethod?.groups?.[0]?.id ?? 'acp_group',
          line_item_ids: [],
          selected_option_id: selected,
        },
      ];
    }
    ucp.fulfillment = { methods: [method] };
  }
  return ucp;
}

function toUcpAddress(a: any): any {
  return {
    street_address: `${a.line_one ?? ''} ${a.line_two ?? ''}`.trim(),
    address_locality: a.city ?? '',
    address_region: a.state ?? '',
    postal_code: a.postal_code ?? '',
    address_country: a.country ?? '',
  };
}

// -- UCP doc -> ACP session translation --------------------------------------------------

const STATUS_MAP: Record<string, string> = {
  incomplete: 'not_ready_for_payment',
  requires_escalation: 'requires_escalation',
  ready_for_complete: 'ready_for_payment',
  complete_in_progress: 'complete_in_progress',
  completed: 'completed',
  canceled: 'canceled',
};

const TOTAL_LABELS: Record<string, string> = {
  subtotal: 'Subtotal',
  fulfillment: 'Shipping',
  discount: 'Discount',
  tax: 'Tax',
  total: 'Total',
  items_base_amount: 'Items',
};

const label = (type: string) => TOTAL_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
const acpTotals = (totals: any[]) =>
  (totals ?? []).map((t) => ({ type: t.type, display_text: label(t.type), amount: t.amount }));

export function toAcpSession(tenant: Tenant, doc: any): any {
  const lineItems = (doc.line_items ?? []).map((li: any) => ({
    id: li.id,
    item: { id: li.item.id, name: li.item.title ?? null, unit_amount: li.item.price ?? null },
    quantity: li.quantity,
    totals: acpTotals(li.totals),
  }));

  const options: any[] = [];
  const selected: any[] = [];
  let details: any = null;
  for (const method of doc.fulfillment?.methods ?? []) {
    for (const d of method.destinations ?? []) {
      if (d.id === (method.selected_destination_id ?? null)) {
        details = {
          address: {
            name: d.full_name ?? '',
            line_one: d.street_address,
            city: d.address_locality,
            state: d.address_region,
            country: d.address_country,
            postal_code: d.postal_code,
          },
        };
      }
    }
    for (const group of method.groups ?? []) {
      for (const opt of group.options ?? []) {
        options.push({ type: 'shipping', id: opt.id, title: opt.title, totals: acpTotals(opt.totals) });
      }
      if (group.selected_option_id) {
        selected.push({
          type: 'shipping',
          option_id: group.selected_option_id,
          item_ids: (doc.line_items ?? []).map((li: any) => li.id),
        });
      }
    }
  }

  const session: any = {
    protocol: { version: ACP_VERSION },
    id: doc.id,
    status: STATUS_MAP[doc.status] ?? doc.status,
    currency: (doc.currency ?? '').toLowerCase(),
    line_items: lineItems,
    totals: acpTotals(doc.totals),
    fulfillment_options: options,
    messages: [],
    links: [],
    capabilities: { payment: { handlers: acpHandlers(tenant) } },
  };
  if (selected.length) session.selected_fulfillment_options = selected;
  if (details) session.fulfillment_details = details;
  if (doc.buyer !== undefined) session.buyer = doc.buyer;
  if (doc.discounts !== undefined) session.discounts = doc.discounts;
  if (doc.order !== undefined) {
    session.order = {
      id: doc.order.id,
      checkout_session_id: doc.id,
      permalink_url: doc.order.permalink_url,
    };
  }
  return session;
}

// -- webhooks (merchant -> OpenAI, HMAC-signed) --------------------------------------------

/**
 * POST an order_create/order_update event to the configured ACP webhook URL,
 * signed per spec: Merchant-Signature: t=<unix>,v1=<hex hmac-sha256(t.body)>.
 * URL + secret are provisioned out-of-band (tenant config).
 */
export async function sendAcpOrderWebhook(
  tenant: Tenant,
  orderUuid: string,
  eventType: string,
): Promise<void> {
  const { acpWebhookUrl: url, acpWebhookSecret: secret } = tenant.config;
  if (!url || !secret) return;
  let entity: any;
  try {
    entity = loadOrder(tenant, orderUuid);
  } catch {
    return;
  }
  const body = JSON.stringify({ type: eventType, data: toAcpOrder(entity) });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=` + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  for (let attempt = 0, delay = 500; attempt < 3; attempt++, delay *= 2) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Merchant-Signature': sig,
          Timestamp: new Date(ts * 1000).toISOString(),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status < 500) return;
    } catch {
      /* retry after backoff */
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** UCP order entity -> ACP Order object. */
export function toAcpOrder(e: any): any {
  let shipped = false;
  const fulfillments: any[] = [];
  for (const ev of e.fulfillment?.events ?? []) {
    shipped = shipped || ev.type === 'shipped';
    fulfillments.push({
      id: ev.id,
      type: 'shipping',
      status: ev.type === 'shipped' ? 'shipped' : 'processing',
      line_items: ev.line_items ?? [],
      events: [{ id: ev.id, type: ev.type, occurred_at: ev.occurred_at }],
    });
  }
  return {
    type: 'order',
    id: e.id,
    checkout_session_id: e.checkout_id,
    permalink_url: e.permalink_url,
    status: shipped ? 'shipped' : 'created',
    line_items: e.line_items.map((li: any) => ({
      id: li.id,
      title: li.item.title ?? li.item.id,
      quantity: {
        ordered: li.quantity.total,
        current: li.quantity.total,
        fulfilled: shipped ? li.quantity.total : li.quantity.fulfilled,
      },
      unit_price: li.item.price ?? null,
    })),
    fulfillments,
    totals: acpTotals(e.totals),
  };
}

// -- errors ------------------------------------------------------------------------------

function translateError(op: AcpOp, e: UcpError): AcpResult {
  const codeMap: Record<string, string> = {
    RESOURCE_NOT_FOUND: 'not_found',
    OUT_OF_STOCK: 'out_of_stock',
    IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
    CHECKOUT_NOT_MODIFIABLE: 'conflict',
    INVALID_REQUEST: 'invalid',
  };
  let http = e.http;
  if (op === 'cancel' && e.ucpCode === 'CHECKOUT_NOT_MODIFIABLE') {
    http = 405; // spec: cancel on a terminal session -> 405
  }
  const type = http >= 500 ? 'processing_error' : 'invalid_request';
  return error(http, type, codeMap[e.ucpCode] ?? e.ucpCode.toLowerCase(), e.content);
}

function error(http: number, type: string, code: string, message: string, param?: string): AcpResult {
  const body: any = { type, code, message };
  if (param) body.param = param;
  return { status: http, body };
}
