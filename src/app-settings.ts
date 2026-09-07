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

export const DOCS_URL = 'https://github.com/ooasis/ucp-connector#readme';
const supportEmail = () => process.env.SUPPORT_EMAIL ?? '';

/**
 * The per-store dashboard page: what the app does, setup steps, status, and
 * the settings form. Rendered inside the platform's dashboard iframe, so it is
 * full-width (Wix asks for >= 1200 px) and needs no JavaScript.
 */
export function settingsPage(opts: {
  tenant: Tenant;
  token: string;
  notice: string;
  /** Platform-specific status rows shown under the common ones. */
  rows: SettingsRow[];
  /** Platform name for copy ("Wix", "BigCommerce"). */
  platform: string;
  /** Platform-specific setup steps (HTML allowed via raw()). */
  steps: (string | HtmlEscapedString)[];
}): HtmlEscapedString | Promise<HtmlEscapedString> {
  const { tenant, token, notice, rows, platform, steps } = opts;
  const cfg = tenant.config;
  const checked = (on: boolean) => (on ? raw('checked') : '');
  const stripeReady = !!cfg.stripeSecretKey;
  const legalBase = tenant.baseUrl.replace(/\/[^/]+$/, '');
  return html`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>UCP Agent · ${cfg.merchantName}</title>
<style>
  :root{color-scheme:light}
  body{font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:24px 32px 48px;color:#20303c;background:#fff}
  main{max-width:1200px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:28px 0 8px}
  .sub{color:#5f6f7c;margin:0 0 16px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px} @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{border:1px solid #dfe5eb;border-radius:8px;padding:16px 20px;background:#fff}
  .notice{background:#e8f5e9;border:1px solid #c8e6c9;padding:10px 14px;border-radius:6px;margin:0 0 16px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
  .ok{background:#e3f4e4;color:#1e7b34} .todo{background:#fdecea;color:#b3261e}
  ol{padding-left:22px;margin:8px 0} ol li{margin:6px 0}
  table{border-collapse:collapse;width:100%} td{padding:6px 10px 6px 0;vertical-align:top;border-bottom:1px solid #eef2f5} td:first-child{color:#5f6f7c;white-space:nowrap;width:180px}
  code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:12.5px;word-break:break-all}
  label{display:block;margin:12px 0 4px;font-weight:600} label.check{font-weight:500;margin:8px 0}
  input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #c2ccd6;border-radius:6px;font-size:14px}
  small{color:#5f6f7c;font-weight:400}
  button{margin-top:16px;background:#116dff;color:#fff;border:0;border-radius:20px;padding:9px 22px;font-size:14px;font-weight:600;cursor:pointer}
  footer{margin-top:32px;color:#5f6f7c;font-size:13px} footer a{color:#116dff;text-decoration:none;margin-right:16px}
</style>
<main>
<h1>UCP Agent</h1>
<p class="sub">Lets AI shopping agents buy from <strong>${cfg.merchantName}</strong> through the open Universal Commerce Protocol.
Agents discover your store, build a checkout with live prices, stock, shipping rates and coupons, pay with Google Pay through your Stripe account,
and the result is a normal ${platform} order that you fulfil as usual.</p>
${notice ? html`<p class="notice">${notice}</p>` : ''}
<div class="grid">
  <section class="card">
    <h2 style="margin-top:0">Setup</h2>
    <ol>
      <li>${stripeReady ? html`<span class="pill ok">done</span>` : html`<span class="pill todo">to do</span>`}
        Connect Stripe: paste a <strong>restricted secret key</strong> from your Stripe dashboard in the form. Agent payments are charged to your Stripe account; ${platform} records them on the order.</li>
      ${steps.map((step) => html`<li>${step}</li>`)}
      <li>Test it: with the UCP endpoint below, an agent (or the <a href="${DOCS_URL}">test script in the documentation</a>) can place an order that appears under Orders in ${platform}.</li>
    </ol>
  </section>
  <section class="card">
    <h2 style="margin-top:0">Status</h2>
    <table>
      <tr><td>UCP endpoints</td><td>${cfg.enabled ? html`<span class="pill ok">enabled</span>` : html`<span class="pill todo">disabled</span>`}</td></tr>
      <tr><td>UCP endpoint</td><td><code>${tenant.baseUrl}/ucp</code></td></tr>
      <tr><td>Hosted profile</td><td><a href="${tenant.baseUrl}/.well-known/ucp">${tenant.baseUrl}/.well-known/ucp</a></td></tr>
      ${rows.map(([label, value]) => html`<tr><td>${label}</td><td>${value}</td></tr>`)}
      <tr><td>Payment handlers</td><td>${stripeReady ? 'Google Pay via Stripe' : 'none (connect Stripe)'}${cfg.simulationSecret ? ' + mock handler (test mode)' : ''}</td></tr>
    </table>
  </section>
</div>
<section class="card" style="margin-top:24px">
  <h2 style="margin-top:0">Settings</h2>
  <form method="post" action="settings">
    <input type="hidden" name="token" value="${token}">
    <div class="grid">
      <div>
        <label class="check"><input type="checkbox" name="enabled" ${checked(cfg.enabled)}> Enable UCP endpoints</label>
        <label class="check"><input type="checkbox" name="strictSignatures" ${checked(cfg.strictSignatures)}> Require signed requests (RFC 9421) <small>— reject agents that do not sign their requests</small></label>
        <label>Stripe secret key <small>(${mask(cfg.stripeSecretKey)}; leave blank to keep)</small></label>
        <input type="password" name="stripeSecretKey" autocomplete="off" placeholder="rk_live_… or sk_test_…">
        <label>Stripe publishable key <small>(optional, lets agents tokenize Google Pay against your account)</small></label>
        <input type="text" name="stripePublishableKey" value="${cfg.stripePublishableKey}" placeholder="pk_live_…">
        <label class="check"><input type="checkbox" name="clearStripe"> Remove Stripe keys</label>
      </div>
      <div>
        <label>Simulation secret <small>(${mask(cfg.simulationSecret)}; test mode only — leave empty on a live store)</small></label>
        <input type="password" name="simulationSecret" autocomplete="off">
        <p><small>With a simulation secret set, the mock payment handler is advertised so integrators can run the UCP conformance suite without charging cards.</small></p>
        <label class="check"><input type="checkbox" name="clearSimulation"> Remove simulation secret</label>
      </div>
    </div>
    <button type="submit">Save</button>
  </form>
</section>
<footer>
  <a href="${DOCS_URL}">Documentation</a>
  ${supportEmail() ? html`<a href="mailto:${supportEmail()}">Support: ${supportEmail()}</a>` : ''}
  <a href="${legalBase}/legal/privacy">Privacy policy</a>
  <a href="${legalBase}/legal/terms">Terms of use</a>
</footer>
</main>`;
}
