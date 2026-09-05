/**
 * End-to-end smoke: boots the connector on an ephemeral port with a throwaway
 * DB, then drives the dev tenant through profile discovery, the checkout state
 * machine, idempotency replay/conflict, version negotiation, discounts, signed
 * requests (RFC 9421 verify path), completion with the mock handler, order
 * webhooks, and the ACP layer. Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckoutResponseSchema } from '@ucp-js/sdk';

process.env.UCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ucp-smoke-'));
process.env.UCP_NO_LISTEN = '1';

const { app } = await import('../src/index.js');
const { serve } = await import('@hono/node-server');
const rfc9421 = await import('../src/rfc9421.js');
const { acpApiKey } = await import('../src/tenants.js');

// -- servers ---------------------------------------------------------------------

const server = serve({ fetch: app.fetch, port: 0 });
const port: number = (server.address() as any).port;
const base = `http://localhost:${port}/dev`;

// Mock agent platform: serves an agent profile (keys + webhook_url) and
// collects webhook deliveries — what the conformance suite's mock does.
const agentKeys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
])) as import('node:crypto').webcrypto.CryptoKeyPair;
const agentPrivateJwk = await crypto.subtle.exportKey('jwk', agentKeys.privateKey);
const agentPublicJwk: any = {
  kty: 'EC',
  crv: 'P-256',
  x: agentPrivateJwk.x,
  y: agentPrivateJwk.y,
};
agentPublicJwk.kid = rfc9421.ecJwkThumbprint(agentPublicJwk);

const webhooks: { headers: Record<string, string>; body: any }[] = [];
const agentServer = createServer((req, res) => {
  if (req.url === '/webhook' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      webhooks.push({ headers: req.headers as any, body: JSON.parse(raw) });
      res.writeHead(200).end('{}');
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ucp: {
        version: '2026-04-08',
        capabilities: {
          'dev.ucp.shopping.order': [
            { name: 'dev.ucp.shopping.order', config: { webhook_url: `http://127.0.0.1:${agentPort}/webhook` } },
          ],
        },
        keys: [agentPublicJwk],
      },
    }),
  );
});
await new Promise<void>((r) => agentServer.listen(0, '127.0.0.1', r));
const agentPort = (agentServer.address() as any).port;
const ucpAgentHeader = `SmokeAgent/1.0; profile="http://127.0.0.1:${agentPort}/profile"`;

// -- helpers -----------------------------------------------------------------------

let idemSeq = 0;
async function call(
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const idem = () => ({ 'idempotency-key': `smoke-${++idemSeq}` });
const totalOf = (totals: any[], type = 'total') => totals.find((t: any) => t.type === type)?.amount;

const destination = {
  street_address: '123 Market St',
  address_locality: 'San Francisco',
  address_region: 'CA',
  postal_code: '94105',
  address_country: 'US',
};

const createBody = {
  line_items: [{ item: { id: 'bouquet_roses' }, quantity: 2 }],
  buyer: { first_name: 'Smoke', last_name: 'Test', email: 'smoke@example.com' },
  fulfillment: {
    methods: [
      {
        type: 'shipping',
        line_item_ids: [],
        destinations: [{ id: 'dest_1', ...destination }],
        selected_destination_id: 'dest_1',
      },
    ],
  },
};

let failures = 0;
function step(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((e) => {
      failures++;
      console.error(`FAIL ${name}: ${e.message}`);
    });
}

// -- the flow ------------------------------------------------------------------------

await step('profile discovery', async () => {
  const res = await call('GET', '/.well-known/ucp');
  assert.equal(res.status, 200);
  assert.equal(res.body.ucp.version, '2026-04-08');
  assert.equal(res.body.ucp.services['dev.ucp.shopping'][0].endpoint, `${base}/ucp`);
  assert.ok(res.body.ucp.capabilities['dev.ucp.shopping.checkout']);
  assert.ok(res.body.ucp.keys[0].kid, 'signing key published');
  assert.ok(res.body.ucp.payment_handlers['dev.mock.payment_handler'], 'mock handler in test mode');
});

await step('version negotiation 422', async () => {
  const res = await call('POST', '/ucp/checkout-sessions', createBody, {
    ...idem(),
    'ucp-agent': 'X/1.0; version="2099-01-01"',
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.messages[0].code, 'VERSION_UNSUPPORTED');
});

let checkoutId = '';
await step('create checkout -> 201 ready_for_complete options', async () => {
  const res = await call('POST', '/ucp/checkout-sessions', createBody, idem());
  assert.equal(res.status, 201);
  checkoutId = res.body.id;
  assert.equal(res.body.status, 'incomplete'); // no option selected yet
  assert.equal(totalOf(res.body.totals, 'subtotal'), 7000);
  const options = res.body.fulfillment.methods[0].groups[0].options;
  assert.deepEqual(
    options.map((o: any) => o.id).sort(),
    ['exp-ship-intl', 'exp-ship-us', 'std-ship'],
  );
  const parsed = CheckoutResponseSchema.safeParse(res.body);
  assert.ok(parsed.success, `SDK schema: ${parsed.success ? '' : parsed.error.message}`);
});

await step('idempotency replay + conflict', async () => {
  const key = { 'idempotency-key': 'smoke-replay' };
  const first = await call('POST', '/ucp/checkout-sessions', createBody, key);
  const replay = await call('POST', '/ucp/checkout-sessions', createBody, key);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.id, first.body.id, 'identical replayed response');
  const conflict = await call(
    'POST',
    '/ucp/checkout-sessions',
    { ...createBody, buyer: { email: 'other@example.com' } },
    key,
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.messages[0].code, 'IDEMPOTENCY_CONFLICT');
});

await step('select shipping option -> ready_for_complete', async () => {
  const res = await call(
    'PUT',
    `/ucp/checkout-sessions/${checkoutId}`,
    {
      fulfillment: {
        methods: [
          {
            ...createBody.fulfillment.methods[0],
            groups: [{ id: 'g1', line_item_ids: [], selected_option_id: 'std-ship' }],
          },
        ],
      },
    },
    idem(),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ready_for_complete');
  assert.equal(totalOf(res.body.totals, 'fulfillment'), 500);
  assert.equal(totalOf(res.body.totals), 7500);
});

await step('discount 10OFF applied on (subtotal + fulfillment)', async () => {
  const res = await call(
    'PUT',
    `/ucp/checkout-sessions/${checkoutId}`,
    { discounts: { codes: ['10OFF'] } },
    idem(),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.discounts.applied[0].amount, 750);
  assert.equal(totalOf(res.body.totals), 6750);
});

await step('known-customer address injection', async () => {
  const res = await call(
    'POST',
    '/ucp/checkout-sessions',
    {
      line_items: [{ item: { id: 'pot_ceramic' }, quantity: 1 }],
      buyer: { email: 'john.doe@example.com' },
      fulfillment: { methods: [{ type: 'shipping', line_item_ids: [] }] },
    },
    idem(),
  );
  assert.equal(res.status, 201);
  const dests = res.body.fulfillment.methods[0].destinations;
  assert.equal(dests.length, 2, 'stored addresses injected');
  assert.equal(dests[0].street_address, '123 Main St');
});

await step('out-of-stock item rejected with stock error', async () => {
  const res = await call(
    'POST',
    '/ucp/checkout-sessions',
    { line_items: [{ item: { id: 'gardenias' }, quantity: 1 }] },
    idem(),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.messages[0].code, 'OUT_OF_STOCK');
});

await step('signed request verified (RFC 9421 round trip)', async () => {
  const body = JSON.stringify(createBody);
  const path = '/dev/ucp/checkout-sessions';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'ucp-agent': ucpAgentHeader,
    'idempotency-key': `smoke-signed-${Date.now()}`,
  };
  const sigHeaders = await rfc9421.signRestRequest(
    { method: 'POST', authority: `localhost:${port}`, path, body, headers },
    agentPrivateJwk as any,
    agentPublicJwk.kid,
  );
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { ...headers, ...sigHeaders },
    body,
  });
  assert.equal(res.status, 201, `signed create: ${res.status} ${await res.clone().text()}`);

  // Tampered body must fail the digest check.
  const tampered = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { ...headers, ...sigHeaders, 'idempotency-key': 'smoke-tampered' },
    body,
  });
  assert.equal(tampered.status, 401, 'idempotency-key not covered by signature -> rejected');
});

let orderId = '';
await step('complete with mock token -> completed + order webhook', async () => {
  // Recreate under the agent profile so the webhook URL is attached.
  const created = await call('POST', '/ucp/checkout-sessions', createBody, {
    ...idem(),
    'ucp-agent': ucpAgentHeader,
  });
  const id = created.body.id;
  await call(
    'PUT',
    `/ucp/checkout-sessions/${id}`,
    {
      fulfillment: {
        methods: [
          {
            ...createBody.fulfillment.methods[0],
            groups: [{ id: 'g1', line_item_ids: [], selected_option_id: 'std-ship' }],
          },
        ],
      },
    },
    { ...idem(), 'ucp-agent': ucpAgentHeader },
  );
  const res = await call(
    'POST',
    `/ucp/checkout-sessions/${id}/complete`,
    {
      payment: {
        instruments: [
          {
            id: 'instr_1',
            handler_id: 'mock_payment_handler',
            type: 'card',
            credential: { type: 'token', token: 'success_token' },
          },
        ],
      },
    },
    { ...idem(), 'ucp-agent': ucpAgentHeader },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'completed');
  orderId = res.body.order.id;
  assert.ok(!JSON.stringify(res.body).includes('success_token'), 'credentials never echoed');
  assert.equal(webhooks.length, 1, 'order_placed webhook delivered');
  assert.equal(webhooks[0].headers['x-event-type'], 'order_placed');
  assert.ok(webhooks[0].headers['signature-input']?.includes('webhook-id'), 'webhook signed');
});

await step('declined mock token -> 402, session stays modifiable', async () => {
  const created = await call('POST', '/ucp/checkout-sessions', createBody, idem());
  const id = created.body.id;
  await call(
    'PUT',
    `/ucp/checkout-sessions/${id}`,
    {
      fulfillment: {
        methods: [
          {
            ...createBody.fulfillment.methods[0],
            groups: [{ id: 'g1', line_item_ids: [], selected_option_id: 'std-ship' }],
          },
        ],
      },
    },
    idem(),
  );
  const res = await call(
    'POST',
    `/ucp/checkout-sessions/${id}/complete`,
    {
      payment: {
        instruments: [
          { id: 'i1', handler_id: 'mock_payment_handler', type: 'card', credential: { type: 'token', token: 'fail_token' } },
        ],
      },
    },
    idem(),
  );
  assert.equal(res.status, 402);
  assert.equal(res.body.messages[0].code, 'INSUFFICIENT_FUNDS');
});

await step('get order + simulate shipping webhook', async () => {
  const res = await call('GET', `/ucp/orders/${orderId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, orderId);
  const denied = await call('POST', `/testing/simulate-shipping/${orderId}`, undefined, {
    'simulation-secret': 'wrong',
  });
  assert.equal(denied.status, 403);
  const shipped = await call('POST', `/testing/simulate-shipping/${orderId}`, undefined, {
    'simulation-secret': 'super-secret-sim-key',
  });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
  assert.equal(webhooks.length, 2, 'order_shipped webhook delivered');
  assert.equal(webhooks[1].headers['x-event-type'], 'order_shipped');
  assert.equal(webhooks[1].body.fulfillment.events[0].type, 'shipped');
});

await step('cancel is terminal (409 on further mutation)', async () => {
  const created = await call('POST', '/ucp/checkout-sessions', createBody, idem());
  const id = created.body.id;
  const canceled = await call('POST', `/ucp/checkout-sessions/${id}/cancel`, {}, idem());
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.status, 'canceled');
  const mutate = await call('PUT', `/ucp/checkout-sessions/${id}`, { buyer: {} }, idem());
  assert.equal(mutate.status, 409);
  assert.equal(mutate.body.messages[0].code, 'CHECKOUT_NOT_MODIFIABLE');
});

await step('ACP dual-protocol flow', async () => {
  const disco = await call('GET', '/.well-known/acp.json');
  assert.equal(disco.status, 200);
  assert.equal(disco.body.api_base_url, `${base}/acp`);

  const unauth = await call('POST', '/acp/checkout_sessions', {}, idem());
  assert.equal(unauth.status, 401);

  const auth = { authorization: `Bearer ${acpApiKey('dev')}` };
  const created = await call(
    'POST',
    '/acp/checkout_sessions',
    {
      line_items: [{ item: { id: 'bouquet_roses' }, quantity: 1 }],
      fulfillment_details: {
        name: 'Smoke Test',
        address: { line_one: '123 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105', country: 'US' },
      },
    },
    { ...idem(), ...auth },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, 'not_ready_for_payment');
  assert.equal(created.body.currency, 'usd');
  const optionId = created.body.fulfillment_options.find((o: any) => o.id === 'std-ship').id;

  const updated = await call(
    'POST',
    `/acp/checkout_sessions/${created.body.id}`,
    { selected_fulfillment_options: [{ type: 'shipping', option_id: optionId }] },
    { ...idem(), ...auth },
  );
  assert.equal(updated.body.status, 'ready_for_payment', JSON.stringify(updated.body));

  const completed = await call(
    'POST',
    `/acp/checkout_sessions/${created.body.id}/complete`,
    {
      payment_data: {
        handler_id: 'mock_payment_handler',
        instrument: { type: 'card', credential: { type: 'token', token: 'success_token' } },
      },
    },
    { ...idem(), ...auth },
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.status, 'completed');
  assert.ok(completed.body.order.id);

  const badVersion = await call('GET', `/acp/checkout_sessions/${created.body.id}`, undefined, {
    ...auth,
    'api-version': '2020-01-01',
  });
  assert.equal(badVersion.status, 400);
  assert.deepEqual(badVersion.body.supported_versions, ['2026-04-17']);
});

server.close();
agentServer.close();
if (failures) {
  console.error(`\n${failures} smoke step(s) failed`);
  process.exit(1);
}
console.log('\nsmoke: all steps passed');
process.exit(0);
