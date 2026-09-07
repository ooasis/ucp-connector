/**
 * Act as a UCP shopping agent against a tenant: create a checkout session,
 * pick the first shipping option, optionally apply a coupon, and complete it.
 *
 *   npx tsx scripts/agent-checkout.ts <tenantBaseUrl> <itemId> [options]
 *     --qty 1                 quantity
 *     --coupon CODE           discount code to apply
 *     --handler google_pay    payment handler: google_pay (Stripe tok_visa test
 *                             token) or mock (needs the tenant's simulation secret)
 *     --email a@b.c           buyer email (default agent-test@example.com)
 *
 * Example (deployed connector, Stripe test key on the tenant):
 *   npx tsx scripts/agent-checkout.ts https://ucp-connector.example.workers.dev/<tenantId> <productId> --coupon 10OFF
 */

import { randomUUID } from 'node:crypto';

const [base, itemId, ...rest] = process.argv.slice(2);
if (!base || !itemId) {
  console.error('usage: agent-checkout.ts <tenantBaseUrl> <itemId> [--qty N] [--coupon CODE] [--handler google_pay|mock] [--email E]');
  process.exit(2);
}
const opt = (name: string, fallback: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const qty = Number(opt('qty', '1'));
const coupon = opt('coupon', '');
const handler = opt('handler', 'google_pay');
const email = opt('email', 'agent-test@example.com');

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const started = Date.now();
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'user-agent': 'ucp-agent-checkout/1.0',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  console.log(`${method} ${path} -> ${res.status} (${Date.now() - started} ms)`);
  if (!res.ok) {
    console.error(JSON.stringify(json.messages ?? json, null, 2));
    process.exit(1);
  }
  return json;
}

const destination = {
  id: 'dest_1',
  street_address: '1 Main St',
  address_locality: 'Chicago',
  address_region: 'IL',
  postal_code: '60601',
  address_country: 'US',
};

const session = await call('POST', '/ucp/checkout-sessions', {
  line_items: [{ item: { id: itemId }, quantity: qty }],
  buyer: { first_name: 'Agent', last_name: 'Test', email },
  fulfillment: {
    methods: [{ type: 'shipping', destinations: [destination], selected_destination_id: 'dest_1' }],
  },
});
const method = session.fulfillment.methods[0];
const option = method.groups?.[0]?.options?.[0];
if (!option) {
  console.error('no shipping options quoted for the destination');
  process.exit(1);
}
console.log(`  item ok; shipping option "${option.title}" (${option.totals.at(-1).amount} minor units)`);

const updated = await call('PUT', `/ucp/checkout-sessions/${session.id}`, {
  fulfillment: {
    methods: [
      { ...method, selected_destination_id: 'dest_1', groups: [{ ...method.groups[0], selected_option_id: option.id }] },
    ],
  },
  ...(coupon ? { discounts: { codes: [coupon] } } : {}),
});
const totals = Object.fromEntries(updated.totals.map((t: any) => [t.type, t.amount]));
console.log(`  status ${updated.status}; totals ${JSON.stringify(totals)}; discounts ${JSON.stringify((updated.discounts?.applied ?? []).map((d: any) => d.code))}`);

const credential =
  handler === 'mock'
    ? { type: 'token', token: 'success_token' }
    : { type: 'token', token: JSON.stringify({ id: 'tok_visa', object: 'token', type: 'card' }) };
const done = await call('POST', `/ucp/checkout-sessions/${session.id}/complete`, {
  payment: {
    instruments: [
      {
        id: 'instrument_1',
        handler_id: handler === 'mock' ? 'mock_payment_handler' : 'google_pay',
        type: 'card',
        credential,
      },
    ],
  },
});
console.log(`  ${done.status}; UCP order ${done.order?.id}`);
console.log(`  order entity: ${base.replace(/\/$/, '')}/ucp/orders/${done.order?.id}`);
