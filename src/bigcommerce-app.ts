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
import { html, raw } from 'hono/html';
import { bc } from './adapters/bigcommerce.js';
import { businessProfile } from './profile.js';
import { loadTenantConfig, tenantFor, upsertTenant, type Tenant } from './tenants.js';

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;

export const PROFILE_PAGE_PATH = '/.well-known/ucp';
const PROFILE_PAGE_NAME = 'UCP Profile';
/** Store webhooks relayed to /{hash}/bigcommerce/webhooks (see index.ts). */
const WEBHOOK_SCOPES = ['store/order/statusUpdated', 'store/shipment/created'];

// -- signed payloads -------------------------------------------------------------

function hmacEqual(secret: string, data: string, given: Buffer): boolean {
  const expected = createHmac('sha256', secret).update(data).digest();
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** BigCommerce load/uninstall `signed_payload_jwt` (HS256 with the client secret). */
export function verifySignedPayloadJwt(token: string): { storeHash: string; user: any } | null {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  if (!hmacEqual(env('BC_CLIENT_SECRET'), `${h}.${p}`, Buffer.from(s, 'base64url'))) return null;
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

/** Short-lived token authorizing the settings form for one store (1 h). */
function sessionToken(storeHash: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const data = `${storeHash}.${exp}`;
  return `${data}.${createHmac('sha256', env('BC_CLIENT_SECRET')).update(data).digest('base64url')}`;
}

function verifySessionToken(token: string): string | null {
  const [hash, exp, sig] = token.split('.');
  if (!hash || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  return hmacEqual(env('BC_CLIENT_SECRET'), `${hash}.${exp}`, Buffer.from(sig, 'base64url'))
    ? hash
    : null;
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

// -- settings page -------------------------------------------------------------------

const mask = (secret: string) => (secret ? `configured (…${secret.slice(-4)})` : 'not set');

function settingsPage(tenant: Tenant, token: string, notice: string, provisioned: Provision | null) {
  const cfg = tenant.config;
  const checked = (on: boolean) => (on ? raw('checked') : '');
  return html`<!doctype html>
<title>UCP Agent · ${cfg.merchantName}</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#222}
  label{display:block;margin:.8rem 0 .2rem;font-weight:600} input[type=text],input[type=password]{width:100%;padding:.4rem}
  code{background:#f3f3f3;padding:.1rem .3rem} .notice{background:#e8f5e9;padding:.6rem 1rem;border-radius:4px}
  table{border-collapse:collapse} td{padding:.2rem .8rem .2rem 0;vertical-align:top}
</style>
<h1>UCP Agent</h1>
<p>Store <code>${tenant.id}</code> · ${cfg.merchantName} · ${cfg.currency}</p>
${notice ? html`<p class="notice">${notice}</p>` : ''}
<table>
  <tr><td>UCP endpoint</td><td><code>${tenant.baseUrl}/ucp</code></td></tr>
  <tr><td>Hosted profile</td><td><a href="${tenant.baseUrl}/.well-known/ucp">${tenant.baseUrl}/.well-known/ucp</a></td></tr>
  <tr><td>Storefront profile</td><td><code>${cfg.bigcommerceStorefrontUrl}${PROFILE_PAGE_PATH}</code></td></tr>
  ${
    provisioned
      ? html`<tr><td>Webhooks</td><td>${provisioned.webhooks}</td></tr>
  <tr><td>Profile page</td><td>${provisioned.profile}</td></tr>`
      : ''
  }
  <tr><td>Payment handlers</td><td>${cfg.stripeSecretKey ? 'google_pay (Stripe)' : 'none'}${cfg.simulationSecret ? ', mock (test mode)' : ''}</td></tr>
</table>
<form method="post" action="settings">
  <input type="hidden" name="token" value="${token}">
  <label><input type="checkbox" name="enabled" ${checked(cfg.enabled)}> Enable UCP endpoints</label>
  <label><input type="checkbox" name="strictSignatures" ${checked(cfg.strictSignatures)}> Require signed requests (RFC 9421)</label>
  <label>Stripe secret key <small>(${mask(cfg.stripeSecretKey)}; blank keeps)</small></label>
  <input type="password" name="stripeSecretKey" autocomplete="off">
  <label><input type="checkbox" name="clearStripe"> Clear Stripe keys</label>
  <label>Stripe publishable key</label>
  <input type="text" name="stripePublishableKey" value="${cfg.stripePublishableKey}">
  <label>Simulation secret <small>(${mask(cfg.simulationSecret)}; test mode, blank keeps)</small></label>
  <input type="password" name="simulationSecret" autocomplete="off">
  <label><input type="checkbox" name="clearSimulation"> Clear simulation secret</label>
  <p><button type="submit">Save</button></p>
</form>`;
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
  const provisioned = await provision(tenant);
  return c.html(settingsPage(tenant, sessionToken(storeHash), 'Installed.', provisioned));
});

bigcommerceApp.get('/load', (c: Context) => {
  const auth = verifySignedPayloadJwt(c.req.query('signed_payload_jwt') ?? '');
  if (!auth) return c.text('Invalid signed payload', 401);
  const tenant = tenantFor(c, auth.storeHash);
  if (!tenant?.config.bigcommerceAccessToken) return c.text('Store is not installed', 404);
  return c.html(settingsPage(tenant, sessionToken(auth.storeHash), '', null));
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
  const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
  const storeHash = verifySessionToken(str('token'));
  if (!storeHash) return c.text('Session expired, reopen the app', 401);
  const current = loadTenantConfig(storeHash);
  if (!current) return c.text('Store is not installed', 404);

  const update: Record<string, any> = {
    enabled: form.enabled !== undefined,
    strictSignatures: form.strictSignatures !== undefined,
    stripePublishableKey: str('stripePublishableKey'),
  };
  if (form.clearStripe !== undefined) {
    update.stripeSecretKey = '';
    update.stripePublishableKey = '';
  } else if (str('stripeSecretKey')) update.stripeSecretKey = str('stripeSecretKey');
  if (form.clearSimulation !== undefined) update.simulationSecret = '';
  else if (str('simulationSecret')) update.simulationSecret = str('simulationSecret');
  upsertTenant(storeHash, update);

  const tenant = tenantFor(c, storeHash)!;
  let notice = 'Settings saved.';
  try {
    notice += ` Profile page ${await publishProfile(tenant)}.`;
  } catch (e: any) {
    notice += ` Profile page update failed (${e?.message ?? e}).`;
  }
  return c.html(settingsPage(tenant, sessionToken(storeHash), notice, null));
});
