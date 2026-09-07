/**
 * BigCommerce single-click app shell (bigcommerce/PLAN.md phase 5).
 *
 *   GET  /bigcommerce/auth       install callback: OAuth code -> store token,
 *                                tenant upsert (id = store hash), webhook
 *                                registration, profile page publish
 *   GET  /bigcommerce/load       control-panel open (signed_payload_jwt) -> settings page
 *   GET  /bigcommerce/uninstall  signed_payload_jwt -> disable tenant, drop token
 *   POST /bigcommerce/settings   settings form (session token minted by auth/load)
 *
 * Env: BC_CLIENT_ID / BC_CLIENT_SECRET (app credentials), BC_LOGIN_BASE
 * (default https://login.bigcommerce.com), BC_API_BASE (default
 * https://api.bigcommerce.com), PUBLIC_BASE_URL (see tenants.publicOrigin).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bc } from './adapters/bigcommerce.js';
import {
  sessionToken,
  settingsFromForm,
  settingsPage,
  verifySessionToken,
  type SettingsRow,
} from './app-settings.js';
import { businessProfile } from './profile.js';
import { loadTenantConfig, tenantFor, upsertTenant, type Tenant } from './tenants.js';

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;

export const PROFILE_PAGE_PATH = '/.well-known/ucp';
const PROFILE_PAGE_NAME = 'UCP Profile';
/** Store webhooks relayed to /{hash}/bigcommerce/webhooks (see index.ts). */
const WEBHOOK_SCOPES = ['store/order/statusUpdated', 'store/shipment/created'];

// -- signed payloads -------------------------------------------------------------

/** BigCommerce load/uninstall `signed_payload_jwt` (HS256 with the client secret). */
export function verifySignedPayloadJwt(token: string): { storeHash: string; user: any } | null {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const expected = createHmac('sha256', env('BC_CLIENT_SECRET')).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (claims.aud !== env('BC_CLIENT_ID')) return null;
  if (typeof claims.exp === 'number' && claims.exp < Date.now() / 1000) return null;
  const m = /^stores\/([A-Za-z0-9]+)$/.exec(String(claims.sub ?? ''));
  return m ? { storeHash: m[1], user: claims.user } : null;
}

// -- provisioning on the store -----------------------------------------------------

async function registerWebhooks(tenant: Tenant): Promise<number> {
  const destination = `${tenant.baseUrl}/bigcommerce/webhooks`;
  const [, list] = await bc(tenant, 'GET', '/v3/hooks?limit=250');
  const have = new Set(
    (list?.data ?? []).filter((h: any) => h.destination === destination).map((h: any) => h.scope),
  );
  for (const scope of WEBHOOK_SCOPES) {
    if (have.has(scope)) continue;
    const [status] = await bc(tenant, 'POST', '/v3/hooks', {
      scope,
      destination,
      is_active: true,
      headers: { 'x-webhook-secret': tenant.config.bigcommerceWebhookSecret },
    });
    if (status >= 400) throw new Error(`webhook ${scope}: HTTP ${status}`);
  }
  return WEBHOOK_SCOPES.length;
}

/**
 * Push the business profile to the storefront as a raw Pages API page at
 * /.well-known/ucp (create or update). Re-run whenever keys/handlers change.
 */
export async function publishProfile(tenant: Tenant): Promise<'created' | 'updated'> {
  const page = {
    name: PROFILE_PAGE_NAME,
    type: 'raw',
    body: JSON.stringify(await businessProfile(tenant)),
    url: PROFILE_PAGE_PATH,
    is_visible: true,
  };
  const [, list] = await bc(tenant, 'GET', '/v3/content/pages?limit=250');
  const existing = (list?.data ?? []).find(
    (p: any) => p.url === PROFILE_PAGE_PATH || p.name === PROFILE_PAGE_NAME,
  );
  const [status] = existing
    ? await bc(tenant, 'PUT', `/v3/content/pages/${existing.id}`, page)
    : await bc(tenant, 'POST', '/v3/content/pages', page);
  if (status >= 400) throw new Error(`Pages API: HTTP ${status}`);
  return existing ? 'updated' : 'created';
}

type Provision = { webhooks: string; profile: string };

async function provision(tenant: Tenant): Promise<Provision> {
  const out: Provision = { webhooks: '', profile: '' };
  try {
    out.webhooks = `${await registerWebhooks(tenant)} registered`;
  } catch (e: any) {
    out.webhooks = `failed (${e?.message ?? e})`;
  }
  try {
    out.profile = await publishProfile(tenant);
  } catch (e: any) {
    // ponytail: the dot-prefixed page path is undocumented; when the Pages API
    // rejects it the merchant needs a CDN rule — surface it, don't fail install.
    out.profile = `failed (${e?.message ?? e})`;
  }
  return out;
}

function page(c: Context, tenant: Tenant, notice: string, provisioned: Provision | null) {
  const rows: SettingsRow[] = [
    ['Storefront profile', `${tenant.config.bigcommerceStorefrontUrl}${PROFILE_PAGE_PATH}`],
  ];
  if (provisioned) rows.push(['Webhooks', provisioned.webhooks], ['Profile page', provisioned.profile]);
  return c.html(
    settingsPage({ tenant, token: sessionToken(env('BC_CLIENT_SECRET'), tenant.id), notice, rows }),
  );
}

// -- routes -------------------------------------------------------------------------

export const bigcommerceApp = new Hono();

bigcommerceApp.get('/auth', async (c: Context) => {
  const { code, scope, context } = c.req.query();
  const storeHash = /^stores\/([A-Za-z0-9]+)$/.exec(context ?? '')?.[1];
  if (!code || !storeHash) return c.text('Missing code or context', 400);

  let token: any;
  try {
    const res = await fetch(`${env('BC_LOGIN_BASE', 'https://login.bigcommerce.com')}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: env('BC_CLIENT_ID'),
        client_secret: env('BC_CLIENT_SECRET'),
        code,
        scope,
        context,
        grant_type: 'authorization_code',
        redirect_uri: `${c.req.url.split('?')[0]}`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return c.text(`Token exchange failed (HTTP ${res.status})`, 502);
    token = await res.json();
  } catch (e: any) {
    return c.text(`Token exchange failed: ${e?.message ?? e}`, 502);
  }

  const existing = loadTenantConfig(storeHash);
  upsertTenant(storeHash, {
    adapter: 'bigcommerce',
    enabled: true,
    bigcommerceApiBase: env('BC_API_BASE', 'https://api.bigcommerce.com'),
    bigcommerceStoreHash: storeHash,
    bigcommerceAccessToken: String(token.access_token ?? ''),
    bigcommerceWebhookSecret:
      existing?.bigcommerceWebhookSecret || randomBytes(24).toString('base64url'),
  });
  let tenant = tenantFor(c, storeHash)!;
  const [status, store] = await bc(tenant, 'GET', '/v2/store').catch(() => [0, null] as [number, any]);
  if (status > 0 && status < 400 && store) {
    upsertTenant(storeHash, {
      merchantName: store.name || existing?.merchantName || 'UCP Merchant',
      currency: store.currency || 'USD',
      bigcommerceStorefrontUrl: String(store.secure_url ?? '').replace(/\/$/, ''),
    });
    tenant = tenantFor(c, storeHash)!;
  }
  return page(c, tenant, 'Installed.', await provision(tenant));
});

bigcommerceApp.get('/load', (c: Context) => {
  const auth = verifySignedPayloadJwt(c.req.query('signed_payload_jwt') ?? '');
  if (!auth) return c.text('Invalid signed payload', 401);
  const tenant = tenantFor(c, auth.storeHash);
  if (!tenant?.config.bigcommerceAccessToken) return c.text('Store is not installed', 404);
  return page(c, tenant, '', null);
});

bigcommerceApp.get('/uninstall', (c: Context) => {
  const auth = verifySignedPayloadJwt(c.req.query('signed_payload_jwt') ?? '');
  if (!auth) return c.text('Invalid signed payload', 401);
  // BigCommerce revokes the token itself; keep sessions/orders for the record.
  if (loadTenantConfig(auth.storeHash)) {
    upsertTenant(auth.storeHash, { enabled: false, bigcommerceAccessToken: '' });
  }
  return c.json({ ok: true });
});

bigcommerceApp.post('/settings', async (c: Context) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token : '';
  const storeHash = verifySessionToken(env('BC_CLIENT_SECRET'), token);
  if (!storeHash) return c.text('Session expired, reopen the app', 401);
  if (!loadTenantConfig(storeHash)) return c.text('Store is not installed', 404);
  upsertTenant(storeHash, settingsFromForm(form));

  const tenant = tenantFor(c, storeHash)!;
  let notice = 'Settings saved.';
  try {
    notice += ` Profile page ${await publishProfile(tenant)}.`;
  } catch (e: any) {
    notice += ` Profile page update failed (${e?.message ?? e}).`;
  }
  return page(c, tenant, notice, null);
});
