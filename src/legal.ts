/**
 * Privacy policy and terms of use for the hosted connector (App Market
 * listings require both). Operator name/support email come from env
 * (OPERATOR_NAME, SUPPORT_EMAIL). No storage access: safe to serve from the
 * Worker without a tenant.
 */

import { Hono } from 'hono';
import { html } from 'hono/html';

const operator = () => process.env.OPERATOR_NAME ?? 'ooasis';
const support = () => process.env.SUPPORT_EMAIL ?? '';
const UPDATED = '2026-09-07';

const shell = (title: string, body: any) => html`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · UCP Agent</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#20303c}h1{font-size:24px}h2{font-size:17px;margin-top:28px}</style>
<h1>${title}</h1><p><em>Last updated ${UPDATED}. Operated by ${operator()}.${support() ? html` Contact: <a href="mailto:${support()}">${support()}</a>.` : ''}</em></p>
${body}`;

export const legalApp = new Hono();

legalApp.get('/privacy', (c) =>
  c.html(
    shell(
      'Privacy Policy',
      html`
<p>UCP Agent ("the service") lets AI shopping agents place orders on a merchant's store through the Universal Commerce Protocol (UCP). This policy describes what the service processes on behalf of merchants who install it.</p>
<h2>Data the service processes</h2>
<ul>
<li><strong>Merchant configuration</strong>: the store or site identifier, platform API credentials granted at install, Stripe API keys the merchant enters, and settings. Credentials are encrypted at rest (AES-256-GCM) and are never shown again after entry.</li>
<li><strong>Checkout sessions and orders</strong>: the line items, shipping destinations, buyer name, email and phone that an agent submits, the prices and shipping options quoted by the merchant's platform, and the resulting platform order reference. This is the same data the merchant's platform receives for any order.</li>
<li><strong>Payment credentials</strong>: tokenized wallet credentials (for example a Google Pay token) are forwarded to Stripe to create the charge and are not stored. The service never receives or stores raw card numbers.</li>
<li><strong>Agent identity</strong>: the agent platform URL named in the request and the public keys it publishes, used to verify request signatures and deliver order webhooks.</li>
</ul>
<h2>How data is used</h2>
<p>Only to execute checkouts and keep the merchant's platform order in sync: quoting, charging through the merchant's own Stripe account, creating the order, and sending order-status webhooks back to the agent platform that placed the order. The service does not sell data, does not build marketing profiles, and does not use buyer data for its own purposes.</p>
<h2>Sharing</h2>
<p>Data is shared only with the merchant's commerce platform, the merchant's Stripe account, and the agent platform that placed the order. Infrastructure is hosted on Cloudflare.</p>
<h2>Retention</h2>
<p>Merchant configuration is kept while the app is installed. Uninstalling disables the tenant and removes platform credentials. Checkout sessions and order records are retained for order reconciliation and can be deleted on request from the merchant.</p>
<h2>Security</h2>
<p>All endpoints are served over HTTPS. Inbound agent requests may be verified with RFC 9421 HTTP message signatures; outbound webhooks are signed. Platform webhooks are verified against the platform's signing keys. Secrets are encrypted at rest under a key held outside the database.</p>
<h2>Your rights</h2>
<p>Merchants can request export or deletion of their data at any time${support() ? html` by contacting <a href="mailto:${support()}">${support()}</a>` : ''}. Buyers should contact the merchant they purchased from; the service acts as a processor on the merchant's behalf.</p>`,
    ),
  ),
);

legalApp.get('/terms', (c) =>
  c.html(
    shell(
      'Terms of Use',
      html`
<p>These terms govern use of the UCP Agent app and hosted connector service ("the service") by merchants who install it on their store.</p>
<h2>The service</h2>
<p>The service exposes a merchant's store to AI shopping agents through the Universal Commerce Protocol: it publishes a discovery profile, quotes carts from the store's live catalog, shipping rules and coupons, charges payments through the merchant's own Stripe account, creates orders on the merchant's platform, and relays order updates to the agent that placed the order.</p>
<h2>Merchant responsibilities</h2>
<ul>
<li>You must be entitled to sell the products offered and to accept payments through the Stripe account you connect. Refunds and disputes are handled in Stripe and on your platform, as for any order.</li>
<li>Prices, stock and shipping rates come from your platform configuration; you are responsible for keeping them accurate.</li>
<li>Keep the simulation secret empty on a live store. Test mode advertises a mock payment handler that creates orders without charging.</li>
<li>Use only permissions and data you are allowed to grant under your platform's terms.</li>
</ul>
<h2>Availability and changes</h2>
<p>The service is provided as is, without warranty of uninterrupted availability. Protocol versions, features and these terms may change; material changes are announced in the app dashboard or the documentation.</p>
<h2>Fees</h2>
<p>The app is free. Stripe and your commerce platform charge their own fees.</p>
<h2>Liability</h2>
<p>To the extent permitted by law, ${operator()} is not liable for indirect or consequential loss arising from use of the service, including orders placed by third-party agents. Nothing in these terms limits liability that cannot be limited by law.</p>
<h2>Source code</h2>
<p>The connector's source is published under the PolyForm Shield License 1.0.0. Using the hosted service does not grant additional rights to the source.</p>
<h2>Termination</h2>
<p>You may uninstall the app at any time; this disables your tenant and removes platform credentials. ${operator()} may suspend tenants that abuse the service or violate these terms.</p>`,
    ),
  ),
);
