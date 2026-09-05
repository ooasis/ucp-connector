/**
 * Request pipeline for every UCP endpoint: version negotiation, RFC 9421
 * verification, idempotency replay/409, op execution, UCP error envelopes.
 * Port of the conformance-proven Magento Dispatcher.
 */

import { createHash } from 'node:crypto';
import * as checkout from './checkout.js';
import { idempotencyCheck, idempotencyStore } from './db.js';
import { SignatureError, UcpError } from './errors.js';
import { loadOrder, replaceOrder } from './orders.js';
import { fetchPlatformProfile, VERSION } from './profile.js';
import { verifyRestRequest } from './rfc9421.js';
import type { Tenant } from './tenants.js';

export type UcpRequest = {
  method: string;
  authority: string;
  path: string;
  query: string;
  rawBody: string;
  /** Lowercase header-name map. */
  headers: Record<string, string>;
};

export type UcpOp =
  | 'create_checkout'
  | 'get_checkout'
  | 'update_checkout'
  | 'complete_checkout'
  | 'cancel_checkout'
  | 'get_order'
  | 'update_order';

/** Run a UCP operation, converting any failure into a UCP error envelope. */
export async function dispatch(
  tenant: Tenant,
  op: UcpOp,
  req: UcpRequest,
  id: string | null,
): Promise<[number, any]> {
  try {
    return await run(tenant, op, req, id);
  } catch (e) {
    if (e instanceof UcpError) return error(e);
    return error(new UcpError(500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e)));
  }
}

/**
 * The dispatch pipeline: enablement, version negotiation, signature
 * verification, idempotency replay/conflict, then the operation itself.
 */
async function run(tenant: Tenant, op: UcpOp, req: UcpRequest, id: string | null): Promise<[number, any]> {
  if (!tenant.config.enabled) {
    throw new UcpError(404, 'RESOURCE_NOT_FOUND', 'UCP is not enabled on this store');
  }
  const ucpAgent = req.headers['ucp-agent'] ?? '';
  checkVersion(ucpAgent);
  await verifySignatureIfPresent(tenant, req);
  const mutating = !op.startsWith('get_');
  const successStatus = op === 'create_checkout' ? 201 : 200;

  if (mutating && op !== 'update_order') {
    const idemKey = req.headers['idempotency-key'] ?? '';
    if (!idemKey) {
      throw new UcpError(422, 'INVALID_REQUEST', 'Idempotency-Key header is required');
    }
    const requestHash = hash(op, id, req.rawBody);
    const stored = idempotencyCheck(tenant.id, idemKey, requestHash);
    if (stored !== null) {
      if ('conflict' in stored) {
        throw new UcpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different parameters');
      }
      return [stored.status, stored.body];
    }
    const body = await execute(tenant, op, req, id);
    idempotencyStore(tenant.id, idemKey, requestHash, successStatus, body);
    return [successStatus, body];
  }
  return [successStatus, await execute(tenant, op, req, id)];
}

/** Route the operation to its checkout/order handler with the decoded JSON body. */
async function execute(tenant: Tenant, op: UcpOp, req: UcpRequest, id: string | null): Promise<any> {
  let json: any = {};
  try {
    const parsed = JSON.parse(req.rawBody);
    if (parsed && typeof parsed === 'object') json = parsed;
  } catch {
    /* empty/invalid body treated as {} */
  }
  const agent = req.headers['ucp-agent'] ?? '';
  switch (op) {
    case 'create_checkout':
      return checkout.create(tenant, requireItems(json), agent);
    case 'get_checkout':
      return checkout.load(tenant, id!);
    case 'update_checkout':
      return checkout.update(tenant, id!, json, agent);
    case 'complete_checkout':
      return checkout.complete(tenant, id!, requirePayment(json));
    case 'cancel_checkout':
      return checkout.cancel(tenant, id!);
    case 'get_order':
      return loadOrder(tenant, id!);
    case 'update_order':
      return replaceOrder(tenant, id!, json);
  }
}

/** Require line_items or cart_id in a create_checkout body. */
function requireItems(json: any): any {
  if (!json.line_items?.length && !json.cart_id) {
    throw new UcpError(422, 'INVALID_REQUEST', 'line_items or cart_id is required');
  }
  return json;
}

/** Require the payment object in a complete_checkout body. */
function requirePayment(json: any): any {
  if (json.payment === undefined) {
    throw new UcpError(422, 'INVALID_REQUEST', 'payment is required');
  }
  return json;
}

/** Request hash over operation, resource id, and raw body for conflict detection. */
export function hash(operation: string, resourceId: string | null, rawBody: string): string {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return createHash('sha256').update(`${operation}|${resourceId ?? ''}|${bodyHash}`).digest('hex');
}

/** Date-based version negotiation from the UCP-Agent header. */
function checkVersion(ucpAgent: string): void {
  const m = ucpAgent.match(/(?:^|;)\s*version=(?:"([^"]+)"|([^;]+))/i);
  if (!ucpAgent || !m) return; // no version param: compatible
  const version = (m[1] !== undefined && m[1] !== '' ? m[1] : m[2] ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version) || Number.isNaN(Date.parse(version))) {
    throw new UcpError(422, 'VERSION_INVALID_FORMAT', `Invalid UCP version format: ${version}`);
  }
  if (version > VERSION) {
    throw new UcpError(
      422,
      'VERSION_UNSUPPORTED',
      `Version ${version} is not supported. This merchant implements version ${VERSION}.`,
    );
  }
}

/**
 * RFC 9421 verification of inbound requests. Enforced only when the request
 * carries signature headers (the spec permits unsigned requests with
 * alternative auth; strict mode is the per-tenant toggle).
 */
async function verifySignatureIfPresent(tenant: Tenant, req: UcpRequest): Promise<void> {
  if (!req.headers['signature-input'] || !req.headers['signature']) {
    if (tenant.config.strictSignatures) {
      throw new UcpError(401, 'signature_missing', 'This merchant requires signed requests (RFC 9421)');
    }
    return;
  }
  const agent = req.headers['ucp-agent'] ?? '';
  const platformProfile = await fetchPlatformProfile(tenant, agent);
  const keys = platformProfile?.ucp?.keys ?? platformProfile?.signing_keys ?? [];
  if (!keys.length) {
    throw new UcpError(424, 'profile_unreachable', 'Unable to fetch signer profile keys');
  }
  try {
    await verifyRestRequest(
      {
        method: req.method,
        authority: req.authority,
        path: req.path || '/',
        query: req.query,
        body: req.rawBody || null,
        headers: req.headers,
      },
      keys,
    );
  } catch (e) {
    if (e instanceof SignatureError) {
      const http = ['digest_mismatch', 'algorithm_unsupported'].includes(e.reason) ? 400 : 401;
      throw new UcpError(http, e.reason, e.message);
    }
    throw e;
  }
}

/** Convert a UcpError into [http status, UCP error envelope body]. */
function error(e: UcpError): [number, any] {
  return [
    e.http,
    {
      ucp: { version: VERSION, status: 'error' },
      messages: [
        { type: 'error', code: e.ucpCode, content: e.content, severity: e.severity },
      ],
    },
  ];
}
