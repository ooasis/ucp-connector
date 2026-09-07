/**
 * Wix self-managed app shell (wix/PLAN.md phase 5).
 *
 * Wix apps have no OAuth redirect dance: the app gets a 4 h access token per
 * app instance via client_credentials (adapters/wix.ts), learns about installs
 * from the App Instance Installed webhook, and gets an HMAC-signed `instance`
 * query parameter on its dashboard page. Webhook subscriptions are configured
 * in the app dashboard (not by API), all pointing at ONE URL:
 *
 *   POST /wix/webhooks             app-level webhook sink (JWT signed with the
 *                                  app public key): AppInstalled -> tenant
 *                                  upsert (id = instanceId), AppRemoved ->
 *                                  disable, eCom order/fulfillment events ->
 *                                  signed UCP order webhooks
 *   GET  /wix/dashboard?instance=  dashboard page (signed instance) -> settings
 *   POST /wix/settings             settings form (session token from /dashboard)
 *
 * Env: WIX_APP_ID, WIX_APP_SECRET, WIX_APP_PUBLIC_KEY (PEM, from the app
 * dashboard; verifies webhooks), WIX_API_BASE (default https://www.wixapis.com),
 * PUBLIC_BASE_URL (see tenants.publicOrigin).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { verifyWixWebhookJwt, wix } from './adapters/wix.js';
import {
  sessionToken,
  settingsFromForm,
  settingsPage,
  verifySessionToken,
  type SettingsRow,
} from './app-settings.js';
import { orderIdByPlatformRef } from './db.js';
import { markShipped, pushOrderUpdated } from './orders.js';
import { isPublicUrl } from './profile.js';
import { loadTenantConfig, tenantFor, upsertTenant, type Tenant } from './tenants.js';

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;

// -- signed instance (dashboard page) -----------------------------------------------

/** Wix `instance` query parameter: `<base64url hmac-sha256>.<base64url json>`. */
export function verifySignedInstance(instance: string): { instanceId: string; uid?: string } | null {
  const [sig, data] = instance.split('.');
  if (!sig || !data) return null;
  const expected = createHmac('sha256', env('WIX_APP_SECRET')).update(data).digest();
  const given = Buffer.from(sig, 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return claims.instanceId ? { instanceId: String(claims.instanceId), uid: claims.uid } : null;
  } catch {
    return null;
  }
}

// -- install / remove -------------------------------------------------------------------

/** Create or re-enable the tenant for an app instance, filling site info from Wix. */
export async function installInstance(c: Context, instanceId: string): Promise<Tenant> {
  const existing = loadTenantConfig(instanceId);
  upsertTenant(instanceId, {
    adapter: 'wix',
    enabled: true,
    wixApiBase: env('WIX_API_BASE', 'https://www.wixapis.com'),
    wixInstanceId: instanceId,
  });
  let tenant = tenantFor(c, instanceId)!;
  const [status, body] = await wix(tenant, 'GET', '/apps/v1/instance').catch(
    () => [0, null] as [number, any],
  );
  const site = body?.site;
  if (status > 0 && status < 400 && site) {
    upsertTenant(instanceId, {
      merchantName: site.siteDisplayName || existing?.merchantName || 'UCP Merchant',
      currency: site.paymentCurrency || existing?.currency || 'USD',
      wixSiteId: site.siteId || existing?.wixSiteId || '',
      wixSiteUrl: String(site.url ?? '').replace(/\/$/, ''),
    });
    tenant = tenantFor(c, instanceId)!;
  }
  return tenant;
}

// -- webhook events ------------------------------------------------------------------------

export type WixEvent = { eventType: string; instanceId?: string; entityId?: string; data: any };

/** eCom order/fulfillment events -> UCP order webhooks (shared with the per-tenant route). */
export async function handleWixEcomEvent(tenant: Tenant, event: WixEvent): Promise<void> {
  // Fulfillment events carry the order id as data.orderId; order events as entityId.
  const ref = String(event.data?.orderId ?? event.entityId ?? '');
  const orderUuid = orderIdByPlatformRef(tenant.id, ref);
  if (!orderUuid) return;
  if (event.eventType.includes('fulfillment_created')) await markShipped(tenant, orderUuid);
  else if (/order_(updated|approved)/.test(event.eventType)) await pushOrderUpdated(tenant, orderUuid);
}

// -- .well-known status --------------------------------------------------------------------

/**
 * Wix cannot serve files at the site root, so the merchant fronts the site
 * (Cloudflare Worker / proxy rule) with /.well-known/ucp -> the hosted profile.
 * Check whether that is in place by fetching it from the site.
 */
async function wellKnownStatus(tenant: Tenant): Promise<string> {
  const site = tenant.config.wixSiteUrl;
  if (!site) return 'site URL unknown (site not published?)';
  const url = `${site}/.well-known/ucp`;
  if (!(await isPublicUrl(url))) return `skipped (${url} is not a public URL)`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    if (res.status !== 200) return `missing (HTTP ${res.status} from ${url})`;
    const body: any = await res.json().catch(() => null);
    const endpoint = body?.ucp?.services?.['dev.ucp.shopping']?.[0]?.endpoint;
    return endpoint === `${tenant.baseUrl}/ucp` ? 'ok' : `served, but points at ${endpoint ?? 'nothing'}`;
  } catch (e: any) {
    return `unreachable (${e?.message ?? e})`;
  }
}

async function page(c: Context, tenant: Tenant, notice: string) {
  const rows: SettingsRow[] = [
    ['Site', tenant.config.wixSiteUrl || '(unpublished)'],
    [
      'Storefront profile',
      `${tenant.config.wixSiteUrl || 'https://<your-site>'}/.well-known/ucp → proxy to ${tenant.baseUrl}/.well-known/ucp — status: ${await wellKnownStatus(tenant)}`,
    ],
    ['Webhook sink', `${tenant.baseUrl.replace(/\/[^/]+$/, '')}/wix/webhooks (configured in the app dashboard)`],
  ];
  return c.html(
    settingsPage({ tenant, token: sessionToken(env('WIX_APP_SECRET'), tenant.id), notice, rows }),
  );
}

// -- routes ----------------------------------------------------------------------------------

export const wixApp = new Hono();

wixApp.post('/webhooks', async (c: Context) => {
  const pem = env('WIX_APP_PUBLIC_KEY');
  const event = pem ? verifyWixWebhookJwt(pem, await c.req.text()) : null;
  if (!event?.instanceId) return c.json({ error: 'forbidden' }, 403);
  const type = event.eventType;
  if (/AppInstalled|app_instance_installed|app_installed/i.test(type)) {
    await installInstance(c, event.instanceId);
  } else if (/AppRemoved|app_instance_removed|app_removed/i.test(type)) {
    if (loadTenantConfig(event.instanceId)) upsertTenant(event.instanceId, { enabled: false });
  } else {
    const tenant = tenantFor(c, event.instanceId);
    if (tenant) await handleWixEcomEvent(tenant, event);
  }
  return c.json({ ok: true });
});

wixApp.get('/dashboard', async (c: Context) => {
  const auth = verifySignedInstance(c.req.query('instance') ?? '');
  if (!auth) return c.text('Invalid instance signature', 401);
  // A missed install webhook must not strand the merchant: install on first open.
  const known = tenantFor(c, auth.instanceId);
  const tenant = known ?? (await installInstance(c, auth.instanceId));
  return page(c, tenant, known ? '' : 'Installed.');
});

wixApp.post('/settings', async (c: Context) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token : '';
  const instanceId = verifySessionToken(env('WIX_APP_SECRET'), token);
  if (!instanceId) return c.text('Session expired, reopen the app', 401);
  if (!loadTenantConfig(instanceId)) return c.text('App is not installed', 404);
  upsertTenant(instanceId, settingsFromForm(form));
  return page(c, tenantFor(c, instanceId)!, 'Settings saved.');
});
