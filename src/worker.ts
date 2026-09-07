/**
 * Cloudflare Worker entry. One SQLite-backed Durable Object per tenant holds
 * that tenant's rows (tenants/sessions/idempotency/orders) and runs the shared
 * Hono app against it. The Worker itself only picks the tenant id out of the
 * request (path segment, OAuth context, signed payloads, form tokens — all
 * verified later inside the object) and forwards.
 *
 * Env comes from wrangler vars/secrets; with nodejs_compat_populate_process_env
 * they also appear on process.env, which the shared code reads.
 */

import { DurableObject } from 'cloudflare:workers';
import devTenant from '../config/dev-tenant.json' with { type: 'json' };
import bigcommerceDevTenant from '../config/bigcommerce-dev-tenant.json' with { type: 'json' };
import wixDevTenant from '../config/wix-dev-tenant.json' with { type: 'json' };
import { app } from './app.js';
import { migrate, withDb, type SqlDb, type SqlStatement } from './db.js';
import { seedTenants } from './tenants.js';

type Env = {
  TENANT: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
  /** "1" seeds the config/*-tenant.json dev tenants into their objects (local dev only). */
  SEED_DEV_TENANTS?: string;
};

/** Durable Object SqlStorage -> the synchronous SqlDb the shared code expects. */
function sqlDb(sql: any): SqlDb {
  const statement = (query: string): SqlStatement => ({
    get: (...params) => sql.exec(query, ...params).toArray()[0],
    all: (...params) => sql.exec(query, ...params).toArray(),
    run: (...params) => {
      const cursor = sql.exec(query, ...params);
      return { changes: cursor.rowsWritten };
    },
  });
  return { prepare: statement, exec: (query) => void sql.exec(query) };
}

const DEV_TENANTS = [devTenant, bigcommerceDevTenant, wixDevTenant] as Record<string, any>[];

export class TenantObject extends DurableObject<Env> {
  private readonly db: SqlDb;

  constructor(ctx: any, env: Env) {
    super(ctx, env);
    this.db = sqlDb(ctx.storage.sql);
    migrate(this.db);
    if (env.SEED_DEV_TENANTS === '1') {
      const mine = DEV_TENANTS.filter((t) => t.id === ctx.id.name);
      withDb(this.db, () => seedTenants(mine));
    }
  }

  fetch(request: Request): Promise<Response> {
    return withDb(this.db, () => Promise.resolve(app.fetch(request)));
  }
}

// -- tenant routing (no verification here; the object verifies) ----------------------

const b64json = (part: string | undefined): any => {
  try {
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : null;
  } catch {
    return null;
  }
};

/** BigCommerce signed_payload_jwt -> store hash from `sub: "stores/<hash>"`. */
const bcStoreHash = (jwt: string | null): string | null =>
  /^stores\/([A-Za-z0-9]+)$/.exec(String(b64json(jwt?.split('.')[1])?.sub ?? ''))?.[1] ?? null;

/** Wix webhook JWT body -> instanceId (claims.data is a JSON string). */
function wixInstanceFromJwt(body: string): string | null {
  const claims = b64json(body.trim().split('.')[1]);
  const event = typeof claims?.data === 'string' ? b64json(Buffer.from(claims.data).toString('base64url')) : claims?.data;
  return event?.instanceId ? String(event.instanceId) : null;
}

/** Settings forms carry our session token `<tenantId>.<exp>.<sig>`. */
const formTenant = (body: string): string | null =>
  new URLSearchParams(body).get('token')?.split('.')[0] || null;

async function tenantIdFor(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const [first, second] = url.pathname.split('/').filter(Boolean);
  if (!first || first === 'healthz') return null;
  if (first === 'bigcommerce') {
    if (second === 'auth') return /^stores\/([A-Za-z0-9]+)$/.exec(url.searchParams.get('context') ?? '')?.[1] ?? null;
    if (second === 'load' || second === 'uninstall') return bcStoreHash(url.searchParams.get('signed_payload_jwt'));
    if (second === 'settings') return formTenant(await request.clone().text());
    return null;
  }
  if (first === 'wix') {
    if (second === 'webhooks') return wixInstanceFromJwt(await request.clone().text());
    if (second === 'dashboard') return String(b64json(url.searchParams.get('instance')?.split('.')[1])?.instanceId ?? '') || null;
    if (second === 'settings') return formTenant(await request.clone().text());
    return null;
  }
  return first;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/healthz') return Response.json({ ok: true });
    const tenantId = await tenantIdFor(request);
    if (!tenantId) return Response.json({ error: 'unknown tenant' }, { status: 404 });
    return env.TENANT.get(env.TENANT.idFromName(tenantId)).fetch(request);
  },
};
