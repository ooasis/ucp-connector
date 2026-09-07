/**
 * Shared pieces of the per-store app shells (bigcommerce-app.ts, wix-app.ts):
 * the settings page, the settings-form -> tenant config mapping, and the
 * short-lived HMAC session token that authorizes the form.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Tenant, TenantConfig } from './tenants.js';

// -- session token ------------------------------------------------------------------

function hmacEqual(secret: string, data: string, given: Buffer): boolean {
  const expected = createHmac('sha256', secret).update(data).digest();
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Token authorizing the settings form for one tenant (1 h). */
export function sessionToken(secret: string, tenantId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const data = `${tenantId}.${exp}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

export function verifySessionToken(secret: string, token: string): string | null {
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  return hmacEqual(secret, `${id}.${exp}`, Buffer.from(sig, 'base64url')) ? id : null;
}

// -- form -------------------------------------------------------------------------------

/** Settings form -> config patch. Blank secret fields keep, checkboxes clear. */
export function settingsFromForm(form: Record<string, any>): Partial<TenantConfig> {
  const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
  const update: Partial<TenantConfig> = {
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
  return update;
}

// -- page ----------------------------------------------------------------------------------

export type SettingsRow = [label: string, value: string | HtmlEscapedString];

const mask = (secret: string) => (secret ? `configured (…${secret.slice(-4)})` : 'not set');

export function settingsPage(opts: {
  tenant: Tenant;
  token: string;
  notice: string;
  /** Platform-specific status rows shown under the common ones. */
  rows: SettingsRow[];
}): HtmlEscapedString | Promise<HtmlEscapedString> {
  const { tenant, token, notice, rows } = opts;
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
<p>Tenant <code>${tenant.id}</code> · ${cfg.merchantName} · ${cfg.currency}</p>
${notice ? html`<p class="notice">${notice}</p>` : ''}
<table>
  <tr><td>UCP endpoint</td><td><code>${tenant.baseUrl}/ucp</code></td></tr>
  <tr><td>Hosted profile</td><td><a href="${tenant.baseUrl}/.well-known/ucp">${tenant.baseUrl}/.well-known/ucp</a></td></tr>
  ${rows.map(([label, value]) => html`<tr><td>${label}</td><td>${value}</td></tr>`)}
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
