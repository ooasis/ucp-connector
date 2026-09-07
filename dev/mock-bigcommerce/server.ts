/**
 * Mock BigCommerce API for local dev of the BigCommerce adapter — covers
 * exactly the endpoints the adapter calls (Catalog/Customers/Carts/Checkouts
 * V3, Coupons/Orders V2), with response shapes per the BigCommerce docs cited
 * in bigcommerce/PLAN.md. Seeded from config/fixtures.json (flower shop), so
 * the bigcommerce-dev tenant behaves exactly like the stub `dev` tenant.
 *
 * State is in-memory; auth is a fixed X-Auth-Token (BC_MOCK_TOKEN, default
 * "mock-token"). App-shell endpoints (plan phase 5): POST /oauth2/token
 * (client id/secret BC_MOCK_CLIENT_ID/SECRET, default mock-client-id /
 * mock-client-secret, returns the fixed token), GET /v2/store, Webhooks V3
 * (/v3/hooks), Pages V3 (/v3/content/pages). Debug: GET /_orders, /_hooks,
 * /_pages; GET /_storefront/{hash}{url} serves a pushed page body.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtures = JSON.parse(readFileSync(join(ROOT, 'config', 'fixtures.json'), 'utf8'));
const TOKEN = process.env.BC_MOCK_TOKEN ?? 'mock-token';
const CLIENT_ID = process.env.BC_MOCK_CLIENT_ID ?? 'mock-client-id';
const CLIENT_SECRET = process.env.BC_MOCK_CLIENT_SECRET ?? 'mock-client-secret';

// -- seed: flower-shop fixtures -> BigCommerce entities -------------------------

const products = fixtures.products.map((p: any, i: number) => ({
  id: 101 + i,
  name: p.title,
  sku: p.id,
  price: p.price / 100,
  inventory_level: p.stock ?? 0,
  inventory_tracking: p.stock === null ? 'none' : 'product',
  availability: 'available',
  type: 'physical',
  is_visible: true,
}));

const coupons = fixtures.discounts.map((d: any, i: number) => ({
  id: 1 + i,
  name: d.title,
  code: d.code,
  type: d.type === 'percentage' ? 'percentage_discount' : 'per_total_discount',
  amount: (d.type === 'percentage' ? d.value : d.value / 100).toFixed(2),
  enabled: true,
  applies_to: { entity: 'categories', ids: [0] },
  num_uses: 0,
}));

const customers: any[] = [];
const customerAddresses: any[] = [];
let addrSeq = 1;
fixtures.customers.forEach((c: any, i: number) => {
  const [first, ...rest] = String(c.name).split(' ');
  const customer = { id: 1001 + i, email: c.email, first_name: first, last_name: rest.join(' ') };
  customers.push(customer);
  for (const a of c.addresses) {
    customerAddresses.push({
      id: addrSeq++,
      customer_id: customer.id,
      first_name: customer.first_name,
      last_name: customer.last_name,
      address1: a.street_address,
      address2: '',
      city: a.address_locality,
      state_or_province: a.address_region,
      postal_code: a.postal_code,
      country_code: a.address_country,
      address_type: 'residential',
    });
  }
});

// -- in-memory carts / checkouts / orders ---------------------------------------

type Cart = {
  id: string;
  physical_items: any[];
  base_amount: number; // dollars
  billing_address: any | null;
  consignments: any[];
  coupons: any[];
};
const carts = new Map<string, Cart>();
const orders = new Map<number, any>();
// Real BC order ids are unique per store forever; the connector DB persists
// across mock restarts, so a fixed seed would duplicate platform_refs there.
let orderSeq = Math.floor(Date.now() / 1000) % 100_000_000;

const V2_ORDER_STATUSES: Record<number, string> = {
  0: 'Incomplete',
  7: 'Awaiting Payment',
  11: 'Awaiting Fulfillment',
};

/** Rate options for an address+cart per the fixture shipping rules. */
function shippingOptionsFor(cart: Cart, address: any): any[] {
  const country = address?.country_code || 'US';
  const options: any[] = [];
  for (const r of fixtures.shippingRates) {
    if (r.country === 'default' || r.country === country) {
      options.push({ id: r.id, type: 'shipping_flatrate', description: r.title, cost: r.price / 100 });
    }
  }
  const fs = fixtures.freeShipping;
  if (
    (fs.minSubtotal != null && cart.base_amount * 100 >= fs.minSubtotal) ||
    cart.physical_items.some((pi) => fs.eligibleItemIds.includes(pi.sku))
  ) {
    options.push({ id: 'free-ship', type: 'freeshipping', description: 'Free Shipping', cost: 0 });
  }
  return options;
}

/** Checkouts V3 response document for a cart. */
function checkoutView(cart: Cart): any {
  const shipping = cart.consignments.reduce(
    (sum, cs) => sum + (cs.selected_shipping_option?.cost ?? 0),
    0,
  );
  // Coupons: sequential on the shrinking base, mirroring the store's promotion engine.
  let running = cart.base_amount + shipping;
  let discount = 0;
  const appliedCoupons = cart.coupons.map((cp) => {
    const amount =
      cp.type === 'percentage_discount'
        ? Math.trunc(running * Number(cp.amount)) / 100
        : Math.min(running, Number(cp.amount));
    running -= amount;
    discount += amount;
    return { id: String(cp.id), code: cp.code, coupon_type: cp.type, discounted_amount: amount };
  });
  return {
    id: cart.id,
    cart: {
      id: cart.id,
      currency: { code: 'USD' },
      base_amount: cart.base_amount,
      cart_amount: cart.base_amount - discount,
      line_items: {
        physical_items: cart.physical_items,
        digital_items: [],
        gift_certificates: [],
        custom_items: [],
      },
    },
    billing_address: cart.billing_address,
    consignments: cart.consignments,
    coupons: appliedCoupons,
    shipping_cost_total_inc_tax: shipping,
    subtotal_inc_tax: cart.base_amount,
    grand_total: cart.base_amount + shipping - discount,
  };
}

const v2Error = (c: Context, status: number, message: string) =>
  c.json([{ status, message }], status as any);
const v3Error = (c: Context, status: number, title: string) =>
  c.json({ status, title, type: 'https://developer.bigcommerce.com/api-docs/getting-started/api-status-codes' }, status as any);
const data = (c: Context, payload: any, status = 200) =>
  c.json({ data: payload, meta: {} }, status as any);

const app = new Hono();

app.use('/stores/*', async (c, next) => {
  if (c.req.header('x-auth-token') !== TOKEN) return v3Error(c, 401, 'Unauthorized');
  await next();
});

// -- OAuth (login.bigcommerce.com/oauth2/token) -------------------------------------

app.post('/oauth2/token', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (
    b.client_id !== CLIENT_ID ||
    b.client_secret !== CLIENT_SECRET ||
    b.grant_type !== 'authorization_code' ||
    !b.code ||
    !/^stores\/[A-Za-z0-9]+$/.test(String(b.context ?? ''))
  ) {
    return c.json({ error: 'Invalid client or authorization code' }, 400);
  }
  const user = { id: 1, username: 'owner@example.com', email: 'owner@example.com' };
  return c.json({
    access_token: TOKEN,
    scope: b.scope ?? '',
    user,
    owner: user,
    context: b.context,
    account_uuid: 'mock-account-uuid',
  });
});

// -- Store information V2 -------------------------------------------------------------

app.get('/stores/:hash/v2/store', (c) => {
  const hash = c.req.param('hash');
  return c.json({
    id: hash,
    name: 'Mock BC Flower Shop',
    currency: 'USD',
    domain: `${hash}.mybigcommerce.test`,
    secure_url: `https://${hash}.mybigcommerce.test`,
  });
});

// -- Webhooks V3 ------------------------------------------------------------------------

const hooks = new Map<number, any>();
let hookSeq = 1;

app.get('/stores/:hash/v3/hooks', (c) => {
  const hash = c.req.param('hash');
  return data(c, [...hooks.values()].filter((h) => h.store_hash === hash));
});

app.post('/stores/:hash/v3/hooks', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.scope || !b.destination) return v3Error(c, 422, 'scope and destination are required');
  const now = Math.floor(Date.now() / 1000);
  const hook = {
    id: hookSeq++,
    client_id: CLIENT_ID,
    store_hash: c.req.param('hash'),
    scope: b.scope,
    destination: b.destination,
    is_active: b.is_active ?? true,
    headers: b.headers ?? {},
    created_at: now,
    updated_at: now,
  };
  hooks.set(hook.id, hook);
  return data(c, hook, 201);
});

// -- Pages V3 ------------------------------------------------------------------------------

const pages = new Map<number, any>();
let pageSeq = 1;

app.get('/stores/:hash/v3/content/pages', (c) => {
  const hash = c.req.param('hash');
  return data(c, [...pages.values()].filter((p) => p.store_hash === hash));
});

function pageFrom(body: any, hash: string, id: number): any {
  return {
    id,
    store_hash: hash,
    name: body.name,
    type: body.type,
    body: body.body ?? '',
    url: body.url,
    is_visible: body.is_visible ?? true,
    is_homepage: false,
    channel_id: 1,
  };
}

app.post('/stores/:hash/v3/content/pages', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.name || !b.type || !String(b.url ?? '').startsWith('/')) {
    return v3Error(c, 422, 'name, type and a url starting with / are required');
  }
  const page = pageFrom(b, c.req.param('hash'), pageSeq++);
  pages.set(page.id, page);
  return data(c, page, 201);
});

app.put('/stores/:hash/v3/content/pages/:id', async (c) => {
  const page = pages.get(Number(c.req.param('id')));
  if (!page || page.store_hash !== c.req.param('hash')) return v3Error(c, 404, 'Page not found');
  const b = await c.req.json().catch(() => ({}));
  pages.set(page.id, pageFrom({ ...page, ...b }, page.store_hash, page.id));
  return data(c, pages.get(page.id));
});

// -- Catalog V3 ------------------------------------------------------------------

app.get('/stores/:hash/v3/catalog/products', (c) => {
  const skuIn = c.req.query('sku:in');
  const sku = c.req.query('sku');
  let out = products;
  if (skuIn !== undefined) {
    const skus = skuIn.split(',');
    out = products.filter((p: any) => skus.includes(p.sku));
  } else if (sku !== undefined) {
    out = products.filter((p: any) => p.sku === sku);
  }
  return c.json({ data: out, meta: { pagination: { total: out.length, count: out.length } } });
});

// -- Coupons V2 --------------------------------------------------------------------

app.get('/stores/:hash/v2/coupons', (c) => {
  const code = c.req.query('code');
  const out = code
    ? coupons.filter((cp: any) => cp.code.toLowerCase() === code.toLowerCase())
    : coupons;
  if (!out.length) return c.body(null, 204); // V2: empty result sets are 204
  return c.json(out);
});

// -- Customers V3 --------------------------------------------------------------------

app.get('/stores/:hash/v3/customers', (c) => {
  const emails = (c.req.query('email:in') ?? '').split(',').filter(Boolean);
  const out = emails.length ? customers.filter((cu) => emails.includes(cu.email)) : customers;
  return c.json({ data: out, meta: { pagination: { total: out.length } } });
});

app.get('/stores/:hash/v3/customers/addresses', (c) => {
  const ids = (c.req.query('customer_id:in') ?? '').split(',').filter(Boolean).map(Number);
  const out = ids.length
    ? customerAddresses.filter((a) => ids.includes(a.customer_id))
    : customerAddresses;
  return c.json({ data: out, meta: { pagination: { total: out.length } } });
});

// -- Carts V3 -----------------------------------------------------------------------

app.post('/stores/:hash/v3/carts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const items: any[] = [];
  for (const li of body.line_items ?? []) {
    const p = products.find((p: any) => p.id === li.product_id);
    if (!p) return v3Error(c, 422, `Product ${li.product_id} could not be found.`);
    if (p.inventory_tracking !== 'none' && li.quantity > p.inventory_level) {
      return v3Error(c, 422, `Insufficient stock for '${p.name}'.`);
    }
    items.push({
      id: randomUUID(),
      parent_id: null,
      product_id: p.id,
      sku: p.sku,
      name: p.name,
      quantity: li.quantity,
      list_price: p.price,
      sale_price: p.price,
      extended_sale_price: p.price * li.quantity,
    });
  }
  const cart: Cart = {
    id: randomUUID(),
    physical_items: items,
    base_amount: items.reduce((sum, i) => sum + i.extended_sale_price, 0),
    billing_address: null,
    consignments: [],
    coupons: [],
  };
  carts.set(cart.id, cart);
  return data(c, checkoutView(cart).cart, 201);
});

app.delete('/stores/:hash/v3/carts/:id', (c) => {
  carts.delete(c.req.param('id'));
  return c.body(null, 204);
});

// -- Checkouts V3 (checkout id === cart id) --------------------------------------------

function cartFrom(c: Context): Cart | null {
  return carts.get(c.req.param('id') ?? '') ?? null;
}

app.post('/stores/:hash/v3/checkouts/:id/billing-address', async (c) => {
  const cart = cartFrom(c);
  if (!cart) return v3Error(c, 404, 'Checkout could not be found.');
  cart.billing_address = { id: randomUUID(), ...(await c.req.json().catch(() => ({}))) };
  return data(c, checkoutView(cart));
});

app.post('/stores/:hash/v3/checkouts/:id/consignments', async (c) => {
  const cart = cartFrom(c);
  if (!cart) return v3Error(c, 404, 'Checkout could not be found.');
  const body = await c.req.json().catch(() => []);
  const withOptions = (c.req.query('include') ?? '').includes(
    'consignments.available_shipping_options',
  );
  cart.consignments = (Array.isArray(body) ? body : [body]).map((cons: any) => ({
    id: randomUUID(),
    shipping_address: cons.address ?? {},
    line_item_ids: (cons.line_items ?? []).map((li: any) => li.item_id),
    available_shipping_options: withOptions ? shippingOptionsFor(cart, cons.address) : [],
    selected_shipping_option: null,
  }));
  return data(c, checkoutView(cart));
});

app.put('/stores/:hash/v3/checkouts/:id/consignments/:cid', async (c) => {
  const cart = cartFrom(c);
  const cons = cart?.consignments.find((cs) => cs.id === c.req.param('cid'));
  if (!cart || !cons) return v3Error(c, 404, 'Consignment could not be found.');
  const body = await c.req.json().catch(() => ({}));
  const option = shippingOptionsFor(cart, cons.shipping_address).find(
    (o) => String(o.id) === String(body.shipping_option_id),
  );
  if (!option) return v3Error(c, 422, 'The requested shipping option is not available.');
  cons.selected_shipping_option = option;
  return data(c, checkoutView(cart));
});

app.post('/stores/:hash/v3/checkouts/:id/coupons', async (c) => {
  const cart = cartFrom(c);
  if (!cart) return v3Error(c, 404, 'Checkout could not be found.');
  const code = String((await c.req.json().catch(() => ({}))).coupon_code ?? '');
  const coupon = coupons.find((cp: any) => cp.code.toLowerCase() === code.toLowerCase());
  if (!coupon || !coupon.enabled) {
    return v3Error(c, 404, `The coupon code '${code}' could not be applied to your cart.`);
  }
  if (!cart.coupons.some((cp) => cp.id === coupon.id)) cart.coupons.push(coupon);
  return data(c, checkoutView(cart));
});

app.post('/stores/:hash/v3/checkouts/:id/orders', (c) => {
  const cart = cartFrom(c);
  if (!cart) return v3Error(c, 404, 'Checkout could not be found.');
  const view = checkoutView(cart);
  const id = ++orderSeq;
  orders.set(id, {
    id,
    status_id: 0,
    status: V2_ORDER_STATUSES[0],
    subtotal_ex_tax: view.subtotal_inc_tax.toFixed(2),
    shipping_cost_ex_tax: view.shipping_cost_total_inc_tax.toFixed(2),
    discount_amount: (view.subtotal_inc_tax + view.shipping_cost_total_inc_tax - view.grand_total).toFixed(2),
    total_inc_tax: view.grand_total.toFixed(2),
    currency_code: 'USD',
    billing_address: cart.billing_address,
    coupons: view.coupons,
    items: cart.physical_items.map((pi) => ({ sku: pi.sku, name: pi.name, quantity: pi.quantity })),
    payment_method: '',
    payment_provider_id: null,
    staff_notes: '',
    cart_id: cart.id,
  });
  carts.delete(cart.id); // BC converts the cart on order creation
  return data(c, { id }, 201);
});

// -- Orders V2 ------------------------------------------------------------------------

app.put('/stores/:hash/v2/orders/:id', async (c) => {
  const order = orders.get(Number(c.req.param('id')));
  if (!order) return v2Error(c, 404, 'The requested resource was not found.');
  const body = await c.req.json().catch(() => ({}));
  for (const k of ['status_id', 'payment_method', 'payment_provider_id', 'staff_notes']) {
    if (body[k] !== undefined) order[k] = body[k];
  }
  order.status = V2_ORDER_STATUSES[order.status_id] ?? `Status ${order.status_id}`;
  return c.json(order);
});

// -- debug (not a BigCommerce endpoint) -------------------------------------------------

app.get('/_orders', (c) => c.json([...orders.values()]));
app.get('/_hooks', (c) => c.json([...hooks.values()]));
app.get('/_pages', (c) => c.json([...pages.values()]));
// What the storefront would serve for a pushed raw page (BigCommerce sends text/html).
app.get('/_storefront/:hash/*', (c) => {
  const hash = c.req.param('hash');
  const url = c.req.path.slice(`/_storefront/${hash}`.length);
  const page = [...pages.values()].find((p) => p.store_hash === hash && p.url === url && p.is_visible);
  if (!page) return c.text('Not found', 404);
  return c.body(page.body, 200, { 'content-type': 'text/html; charset=utf-8' });
});

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mock-bigcommerce listening on http://localhost:${info.port} (token: ${TOKEN})`);
});
