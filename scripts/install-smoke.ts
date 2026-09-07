/**
 * BigCommerce app-shell smoke (plan phase 5): boots the connector in-process
 * against the running mock BigCommerce API (npm run mock:bc, :8788) and drives
 * install -> provisioning (webhooks + profile page) -> load -> settings ->
 * checkout on the new tenant -> uninstall -> reinstall. Exits non-zero on the
 * first failed assertion.
 */

import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK = process.env.BC_MOCK_BASE ?? 'http://localhost:8788';
const CLIENT_ID = 'mock-client-id';
const CLIENT_SECRET = 'mock-client-secret';

process.env.UCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ucp-install-smoke-'));
process.env.UCP_NO_LISTEN = '1';
process.env.BC_CLIENT_ID = CLIENT_ID;
process.env.BC_CLIENT_SECRET = CLIENT_SECRET;
process.env.BC_LOGIN_BASE = MOCK;
process.env.BC_API_BASE = MOCK;

const mockUp = await fetch(`${MOCK}/_hooks`).then((r) => r.ok).catch(() => false);
if (!mockUp) {
  console.error(`mock BigCommerce not reachable at ${MOCK} — run: npm run mock:bc`);
  process.exit(2);
}

const { app } = await import('../src/index.js');
const { serve } = await import('@hono/node-server');
const { loadTenantConfig } = await import('../src/tenants.js');

const server = serve({ fetch: app.fetch, port: 0 });
const port: number = (server.address() as any).port;
const origin = `http://localhost:${port}`;
const HASH = 'smoke' + randomUUID().replace(/-/g, '').slice(0, 8);

let step = 0;
const ok = (msg: string) => console.log(`  ${String(++step).padStart(2)}. ${msg}`);

/** BigCommerce-style load/uninstall JWT (HS256 with the app client secret). */
function signedPayloadJwt(storeHash: string, secret = CLIENT_SECRET, aud = CLIENT_ID): string {
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    aud,
    iss: 'bc',
    iat: now,
    nbf: now,
    exp: now + 3600,
    jti: randomUUID(),
    sub: `stores/${storeHash}`,
    user: { id: 1, email: 'owner@example.com', locale: 'en-US' },
    owner: { id: 1, email: 'owner@example.com' },
    url: '/',
  });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const mockHooks = async () =>
  (await fetch(`${MOCK}/_hooks`).then((r) => (r.json() as Promise<any>))).filter((h: any) => h.store_hash === HASH);
const mockPages = async () =>
  (await fetch(`${MOCK}/_pages`).then((r) => (r.json() as Promise<any>))).filter((p: any) => p.store_hash === HASH);

const tokenOf = (page: string): string => {
  const m = /name="token" value="([^"]+)"/.exec(page);
  assert.ok(m, 'settings page carries a session token');
  return m[1];
};

const postSettings = (token: string, fields: Record<string, string>) =>
  fetch(`${origin}/bigcommerce/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, ...fields }),
  });

try {
  console.log(`install smoke: tenant ${HASH} via ${MOCK}`);

  // -- install -----------------------------------------------------------------------
  let res = await fetch(
    `${origin}/bigcommerce/auth?code=abc123&scope=store_v2_orders&context=stores/${HASH}`,
  );
  assert.equal(res.status, 200);
  let page = await res.text();
  assert.match(page, /Installed\./);
  assert.match(page, /Webhooks<\/td><td>2 registered/);
  assert.match(page, /Profile page<\/td><td>created/);
  ok('auth callback: token exchanged, settings page rendered');

  let cfg = loadTenantConfig(HASH)!;
  assert.equal(cfg.adapter, 'bigcommerce');
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.bigcommerceAccessToken, 'mock-token');
  assert.equal(cfg.merchantName, 'Mock BC Flower Shop');
  assert.equal(cfg.bigcommerceStorefrontUrl, `https://${HASH}.mybigcommerce.test`);
  assert.ok(cfg.bigcommerceWebhookSecret.length >= 24);
  const webhookSecret = cfg.bigcommerceWebhookSecret;
  ok('tenant upserted from OAuth + /v2/store (name, currency, storefront url)');

  const { getDb } = await import('../src/db.js');
  const rawRow = getDb().prepare('SELECT config FROM tenants WHERE id = ?').get(HASH) as any;
  assert.match(JSON.parse(rawRow.config).bigcommerceAccessToken, /^enc:/);
  assert.ok(!rawRow.config.includes('mock-token'));
  ok('access token encrypted at rest');

  const hooks = await mockHooks();
  assert.deepEqual(
    hooks.map((h: any) => h.scope).sort(),
    ['store/order/statusUpdated', 'store/shipment/created'],
  );
  for (const h of hooks) {
    assert.equal(h.destination, `${origin}/${HASH}/bigcommerce/webhooks`);
    assert.equal(h.headers['x-webhook-secret'], webhookSecret);
  }
  ok('two store webhooks registered with the shared secret header');

  const pages = await mockPages();
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, '/.well-known/ucp');
  assert.equal(pages[0].type, 'raw');
  const storefront = await fetch(`${MOCK}/_storefront/${HASH}/.well-known/ucp`);
  assert.equal(storefront.status, 200);
  const published = JSON.parse(await storefront.text());
  assert.equal(
    published.ucp.services['dev.ucp.shopping'][0].endpoint,
    `${origin}/${HASH}/ucp`,
  );
  const hosted = await fetch(`${origin}/${HASH}/.well-known/ucp`).then((r) => (r.json() as Promise<any>));
  assert.deepEqual(published.ucp.keys, hosted.ucp.keys);
  ok('profile page pushed to the storefront; matches the hosted profile');

  // -- load / uninstall auth ----------------------------------------------------------------
  res = await fetch(`${origin}/bigcommerce/load?signed_payload_jwt=${signedPayloadJwt(HASH)}`);
  assert.equal(res.status, 200);
  page = await res.text();
  assert.match(page, /Enable UCP endpoints/);
  ok('load callback: valid signed_payload_jwt renders the settings page');

  for (const bad of [
    signedPayloadJwt(HASH, 'wrong-secret'),
    signedPayloadJwt(HASH, CLIENT_SECRET, 'other-app'),
    'garbage',
  ]) {
    res = await fetch(`${origin}/bigcommerce/load?signed_payload_jwt=${bad}`);
    assert.equal(res.status, 401);
  }
  ok('load callback: bad signature / wrong audience / garbage -> 401');

  // -- settings ------------------------------------------------------------------------------
  const token = tokenOf(page);
  res = await postSettings(token, {
    enabled: 'on',
    stripeSecretKey: 'sk_test_smoke_1234',
    stripePublishableKey: 'pk_test_smoke',
    simulationSecret: 'smoke-secret',
  });
  assert.equal(res.status, 200);
  page = await res.text();
  assert.match(page, /Settings saved\. Profile page updated\./);
  cfg = loadTenantConfig(HASH)!;
  assert.equal(cfg.stripeSecretKey, 'sk_test_smoke_1234');
  assert.equal(cfg.simulationSecret, 'smoke-secret');
  assert.equal((await mockPages()).length, 1);
  assert.doesNotMatch(page, /sk_test_smoke_1234/);
  ok('settings saved; secrets masked in HTML; profile page updated in place (still 1 page)');

  res = await postSettings(tokenOf(page), { enabled: 'on', stripePublishableKey: 'pk_test_smoke' });
  cfg = loadTenantConfig(HASH)!;
  assert.equal(cfg.stripeSecretKey, 'sk_test_smoke_1234');
  assert.equal(cfg.simulationSecret, 'smoke-secret');
  ok('blank secret fields keep the stored values');

  const handlers = Object.values(
    (await fetch(`${origin}/${HASH}/.well-known/ucp`).then((r) => (r.json() as Promise<any>))).ucp.payment_handlers,
  )
    .flat()
    .map((h: any) => h.id)
    .sort();
  assert.deepEqual(handlers, ['google_pay', 'mock_payment_handler']);
  ok('profile advertises google_pay (Stripe) + mock handler (test mode)');

  res = await postSettings('forged.token.here', { enabled: 'on' });
  assert.equal(res.status, 401);
  ok('settings: forged session token -> 401');

  // -- checkout on the installed tenant ----------------------------------------------------
  const base = `${origin}/${HASH}`;
  const create = await fetch(`${base}/ucp/checkout-sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'ucp-agent': 'profile="http://localhost:1/none"',
    },
    body: JSON.stringify({
      line_items: [{ item: { id: 'bouquet_roses' }, quantity: 2 }],
      buyer: { first_name: 'Smoke', last_name: 'Test', email: 'smoke@example.com' },
      fulfillment: {
        methods: [
          {
            type: 'shipping',
            destinations: [
              {
                id: 'dest1',
                street_address: '1 Main St',
                address_locality: 'Chicago',
                address_region: 'IL',
                postal_code: '60601',
                address_country: 'US',
              },
            ],
            selected_destination_id: 'dest1',
          },
        ],
      },
    }),
  });
  assert.equal(create.status, 201);
  const session = await (create.json() as Promise<any>);
  const optionId = session.fulfillment.methods[0].groups[0].options[0].id;
  const update = await fetch(`${base}/ucp/checkout-sessions/${session.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      fulfillment: {
        methods: [
          {
            ...session.fulfillment.methods[0],
            selected_destination_id: 'dest1',
            groups: [{ ...session.fulfillment.methods[0].groups[0], selected_option_id: optionId }],
          },
        ],
      },
    }),
  }).then((r) => (r.json() as Promise<any>));
  assert.equal(update.status, 'ready_for_complete');
  const complete = await fetch(`${base}/ucp/checkout-sessions/${session.id}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      payment: {
        instruments: [
          {
            id: 'pi1',
            handler_id: 'mock_payment_handler',
            type: 'card',
            credential: { type: 'token', token: 'success_token' },
          },
        ],
      },
    }),
  });
  assert.equal(complete.status, 200);
  const done = await (complete.json() as Promise<any>);
  assert.equal(done.status, 'completed');
  assert.ok(done.order?.id);
  ok(`checkout on ${HASH}: create -> option -> complete -> order ${done.order.id}`);

  const bcOrders = (await fetch(`${MOCK}/_orders`).then((r) => (r.json() as Promise<any>))) as any[];
  const placed = bcOrders.find((o) => o.staff_notes === `UCP order ${done.order.id}`);
  assert.ok(placed, 'BigCommerce order created');
  assert.equal(placed.status_id, 11);
  const hookRes = await fetch(`${origin}/${HASH}/bigcommerce/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': webhookSecret },
    body: JSON.stringify({ scope: 'store/shipment/created', data: { orderId: placed.id } }),
  });
  assert.equal(hookRes.status, 200);
  const entity = await fetch(`${base}/ucp/orders/${done.order.id}`).then((r) => (r.json() as Promise<any>));
  assert.ok(
    (entity.fulfillment?.events ?? []).some((e: any) => e.type === 'shipped'),
    'shipped event on the order',
  );
  ok('store shipment webhook with the registered secret -> shipped event');

  // -- uninstall / reinstall -------------------------------------------------------------------
  res = await fetch(`${origin}/bigcommerce/uninstall?signed_payload_jwt=${signedPayloadJwt(HASH)}`);
  assert.equal(res.status, 200);
  cfg = loadTenantConfig(HASH)!;
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.bigcommerceAccessToken, '');
  assert.equal((await fetch(`${origin}/${HASH}/.well-known/ucp`)).status, 404);
  assert.equal(
    (await fetch(`${origin}/bigcommerce/load?signed_payload_jwt=${signedPayloadJwt(HASH)}`)).status,
    404,
  );
  ok('uninstall: tenant disabled, token dropped, profile 404, load 404');

  res = await fetch(
    `${origin}/bigcommerce/auth?code=def456&scope=store_v2_orders&context=stores/${HASH}`,
  );
  assert.equal(res.status, 200);
  cfg = loadTenantConfig(HASH)!;
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.bigcommerceWebhookSecret, webhookSecret);
  assert.equal(cfg.stripeSecretKey, 'sk_test_smoke_1234');
  assert.equal((await mockHooks()).length, 2);
  assert.equal((await mockPages()).length, 1);
  ok('reinstall: re-enabled, settings + webhook secret kept, no duplicate hooks or pages');

  console.log(`install smoke: ${step}/${step} green`);
} catch (e) {
  console.error('install smoke FAILED at step', step + 1);
  console.error(e);
  process.exitCode = 1;
} finally {
  server.close();
}
