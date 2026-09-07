/**
 * Mock Wix API for local dev of the Wix adapter — covers exactly the endpoints
 * the adapter calls (Stores Catalog V3 products + inventory, Catalog V1
 * products for the fallback path, Coupons V2, Contacts V4, eCom Cart V2
 * checkouts / Create Order From Checkout / Order Transactions Add Payments),
 * with response shapes per the Wix docs cited in wix/PLAN.md. Seeded from
 * config/fixtures.json (flower shop), so the wix-dev tenant behaves exactly
 * like the stub `dev` tenant.
 *
 * State is in-memory; auth is a fixed Authorization token (WIX_MOCK_TOKEN,
 * default "mock-wix-token") + a wix-site-id header, or an app-instance token
 * "<token>:<instanceId>" minted by POST /oauth2/token (client_credentials with
 * WIX_MOCK_APP_ID / WIX_MOCK_APP_SECRET, default mock-wix-app-id /
 * mock-wix-app-secret; no site header needed). GET /apps/v1/instance returns
 * the instance + site info. Add Payments dedupes on
 * providerTransactionId and recalculates paymentStatus async (~250ms), like
 * real Wix. Debug endpoints (not Wix): GET /_orders dumps the order store;
 * POST /_emit-webhook {url, eventType, orderId} signs a double-wrapped RS256
 * webhook JWT with dev/mock-wix/webhook-key.pem and delivers it.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const fixtures = JSON.parse(readFileSync(join(ROOT, 'config', 'fixtures.json'), 'utf8'));
const TOKEN = process.env.WIX_MOCK_TOKEN ?? 'mock-wix-token';
const SITE_ID = process.env.WIX_MOCK_SITE_ID ?? 'mock-site';
const APP_ID = process.env.WIX_MOCK_APP_ID ?? 'mock-wix-app-id';
const APP_SECRET = process.env.WIX_MOCK_APP_SECRET ?? 'mock-wix-app-secret';
const SITE_URL = process.env.WIX_MOCK_SITE_URL ?? 'https://mock-site.wixsite.com/flowers';
const WEBHOOK_KEY = readFileSync(join(HERE, 'webhook-key.pem'), 'utf8');

/** Wix decimal-string amount from minor units. */
const dollars = (minor: number): string => (minor / 100).toFixed(2);

// -- seed: flower-shop fixtures -> Wix entities -----------------------------------

const products = new Map<string, any>(
  fixtures.products.map((p: any) => [
    p.id,
    {
      id: p.id,
      name: p.title,
      priceData: { currency: 'USD', price: p.price / 100 },
      stock: { trackInventory: p.stock !== null, quantity: p.stock ?? undefined },
    },
  ]),
);

const coupons = fixtures.discounts.map((d: any) => ({
  id: randomUUID(),
  specification: {
    name: d.title,
    code: d.code,
    active: true,
    ...(d.type === 'percentage'
      ? { percentOffRate: String(d.value) }
      : { moneyOffAmount: d.value / 100 }),
  },
}));

const contacts = fixtures.customers.map((c: any, i: number) => {
  const [first, ...rest] = String(c.name).split(' ');
  return {
    id: `contact-${1001 + i}`,
    info: {
      name: { first, last: rest.join(' ') },
      emails: { items: [{ email: c.email, primary: true }] },
      addresses: {
        items: c.addresses.map((a: any) => ({
          id: randomUUID(),
          tag: 'SHIPPING',
          address: {
            country: a.address_country,
            subdivision: `${a.address_country}-${a.address_region}`,
            city: a.address_locality,
            postalCode: a.postal_code,
            addressLine: a.street_address,
          },
        })),
      },
    },
  };
});

// -- in-memory checkouts / orders ---------------------------------------------------

const checkouts = new Map<string, any>();
const orders = new Map<string, any>();

/** Line-item subtotal in minor units. */
const subtotalOf = (checkout: any): number =>
  checkout.lineItems.reduce(
    (sum: number, li: any) => sum + Math.round(li.price.amount * 100) * li.quantity,
    0,
  );

/** Carrier rates for the checkout's destination per the fixture shipping rules. */
function carrierServiceOptions(checkout: any): any[] {
  const country = checkout.shippingInfo?.shippingDestination?.address?.country || 'US';
  const options: any[] = [];
  const rate = (id: string, title: string, minor: number) => ({
    code: id,
    title,
    logistics: { deliveryTime: '3-7 business days' },
    cost: { price: { amount: dollars(minor), currency: 'USD' } },
  });
  for (const r of fixtures.shippingRates) {
    if (r.country === 'default' || r.country === country) options.push(rate(r.id, r.title, r.price));
  }
  const fs = fixtures.freeShipping;
  if (
    (fs.minSubtotal != null && subtotalOf(checkout) >= fs.minSubtotal) ||
    checkout.lineItems.some((li: any) =>
      fs.eligibleItemIds.includes(li.catalogReference.catalogItemId),
    )
  ) {
    options.push(rate('free-ship', 'Free Shipping', 0));
  }
  return [{ carrierId: 'mock-carrier', shippingOptions: options }];
}

/** priceSummary (+ selected shipping cost) recomputed on every mutation. */
function reprice(checkout: any): void {
  const subtotal = subtotalOf(checkout);
  const selected = checkout.shippingInfo?.selectedCarrierServiceOption;
  const match = carrierServiceOptions(checkout)[0].shippingOptions.find(
    (o: any) => o.code === selected?.code,
  );
  const shipping = match ? Math.round(Number(match.cost.price.amount) * 100) : 0;
  let discount = 0;
  if (checkout.couponCode) {
    const spec = coupons.find(
      (cp: any) => cp.specification.code.toLowerCase() === checkout.couponCode.toLowerCase(),
    )?.specification;
    if (spec?.percentOffRate != null) {
      discount = Math.trunc(((subtotal + shipping) * Number(spec.percentOffRate)) / 100);
    } else if (spec?.moneyOffAmount != null) {
      discount = Math.min(subtotal + shipping, Math.round(spec.moneyOffAmount * 100));
    }
  }
  const money = (minor: number) => ({ amount: dollars(minor), currency: 'USD' });
  checkout.priceSummary = {
    subtotal: money(subtotal),
    shipping: money(shipping),
    discount: money(discount),
    total: money(subtotal + shipping - discount),
  };
}

const wixError = (c: Context, status: number, message: string, code = 'INVALID_ARGUMENT') =>
  c.json({ message, details: { applicationError: { code, description: message } } }, status as any);

const app = new Hono();

/** Instance id carried by an app-instance token, or null for the static token. */
const instanceOf = (auth: string | undefined): string | null =>
  auth?.startsWith(`${TOKEN}:`) ? auth.slice(TOKEN.length + 1) : null;

app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/_') || c.req.path === '/oauth2/token') return next();
  const auth = c.req.header('authorization');
  if (auth !== TOKEN && !instanceOf(auth)) return wixError(c, 401, 'Unauthorized', 'UNAUTHENTICATED');
  // Static (API-key style) tokens must name the site; instance tokens are site-scoped already.
  if (auth === TOKEN && c.req.header('wix-site-id') !== SITE_ID) {
    return wixError(c, 403, 'Unknown site', 'PERMISSION_DENIED');
  }
  return next();
});

// -- OAuth: Create Access Token (client_credentials) + Get App Instance ------------------

app.post('/oauth2/token', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (
    b.grant_type !== 'client_credentials' ||
    b.client_id !== APP_ID ||
    b.client_secret !== APP_SECRET ||
    !b.instance_id
  ) {
    return c.json({ error: 'invalid_client', error_description: 'bad credentials or instance_id' }, 400);
  }
  return c.json({ access_token: `${TOKEN}:${b.instance_id}`, token_type: 'Bearer', expires_in: 14400 });
});

app.get('/apps/v1/instance', (c) => {
  const instanceId = instanceOf(c.req.header('authorization')) ?? 'mock-instance';
  return c.json({
    instance: { instanceId, appName: 'UCP Agent', appVersion: '0.1.0', isFree: true, permissions: [] },
    site: {
      siteId: SITE_ID,
      siteDisplayName: 'Mock Wix Flower Shop',
      locale: 'en',
      paymentCurrency: 'USD',
      url: SITE_URL,
    },
  });
});

// -- Stores: products + coupons ------------------------------------------------------

app.get('/stores/v1/products/:id', (c) => {
  const p = products.get(c.req.param('id'));
  if (!p) return wixError(c, 404, 'Product not found', 'NOT_FOUND');
  return c.json({ product: p });
});

// Catalog V3 (what current sites run): one default variant per fixture product.
app.get('/stores/v3/products/:id', (c) => {
  const p = products.get(c.req.param('id'));
  if (!p) return wixError(c, 404, 'Product not found', 'NOT_FOUND');
  const amount = p.priceData.price.toFixed(2);
  return c.json({
    product: {
      id: p.id,
      name: p.name,
      productType: 'PHYSICAL',
      actualPriceRange: { minValue: { amount }, maxValue: { amount } },
      variantsInfo: {
        variants: [
          {
            id: `${p.id}-default`,
            sku: p.id,
            choices: [],
            price: { actualPrice: { amount } },
            inventoryStatus: { inStock: !p.stock.trackInventory || (p.stock.quantity ?? 0) > 0 },
          },
        ],
      },
    },
  });
});

app.post('/stores/v3/inventory-items/query', async (c) => {
  const filter = (await c.req.json().catch(() => ({})))?.query?.filter ?? {};
  const p = products.get(String(filter.productId ?? ''));
  if (!p) return c.json({ inventoryItems: [] });
  return c.json({
    inventoryItems: [
      {
        id: `inv-${p.id}`,
        productId: p.id,
        variantId: `${p.id}-default`,
        trackQuantity: p.stock.trackInventory,
        quantity: p.stock.trackInventory ? (p.stock.quantity ?? 0) : undefined,
        inStock: !p.stock.trackInventory || (p.stock.quantity ?? 0) > 0,
        availabilityStatus: !p.stock.trackInventory || (p.stock.quantity ?? 0) > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
      },
    ],
  });
});

app.post('/stores/v2/coupons/query', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const filter = JSON.parse(body?.query?.filter ?? '{}');
  const out = filter.code
    ? coupons.filter(
        (cp: any) => cp.specification.code.toLowerCase() === String(filter.code).toLowerCase(),
      )
    : coupons;
  return c.json({ coupons: out, totalResults: out.length });
});

// -- Contacts V4 -----------------------------------------------------------------------

app.post('/contacts/v4/contacts/query', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = body?.query?.filter?.['info.emails.email']?.$eq;
  const out = email
    ? contacts.filter((ct: any) => ct.info.emails.items.some((e: any) => e.email === email))
    : contacts;
  return c.json({ contacts: out });
});

// -- eCom Cart V2 checkouts -------------------------------------------------------------

app.post('/ecom/v1/checkouts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.channelType) return wixError(c, 400, 'channelType is required');
  const lineItems: any[] = [];
  for (const li of body.lineItems ?? []) {
    const p = products.get(li.catalogReference?.catalogItemId ?? '');
    if (!p) return wixError(c, 400, `Catalog item not found: ${li.catalogReference?.catalogItemId}`);
    if (p.stock.trackInventory && li.quantity > (p.stock.quantity ?? 0)) {
      return wixError(c, 409, `Out of stock: ${p.name}`, 'OUT_OF_STOCK');
    }
    lineItems.push({
      id: randomUUID(),
      quantity: li.quantity,
      catalogReference: li.catalogReference,
      productName: { original: p.name },
      price: { amount: p.priceData.price, currency: 'USD' },
    });
  }
  const checkout: any = {
    id: randomUUID(),
    channelType: body.channelType,
    currency: 'USD',
    lineItems,
    buyerInfo: {},
    billingInfo: null,
    shippingInfo: {},
    couponCode: null,
    completed: false,
  };
  reprice(checkout);
  checkouts.set(checkout.id, checkout);
  return c.json({ checkout }, 201);
});

app.get('/ecom/v1/checkouts/:id', (c) => {
  const checkout = checkouts.get(c.req.param('id'));
  if (!checkout) return wixError(c, 404, 'Checkout not found', 'NOT_FOUND');
  return c.json({ checkout });
});

app.patch('/ecom/v1/checkouts/:id', async (c) => {
  const checkout = checkouts.get(c.req.param('id'));
  if (!checkout) return wixError(c, 404, 'Checkout not found', 'NOT_FOUND');
  const patch = (await c.req.json().catch(() => ({})))?.checkout ?? {};
  if (patch.buyerInfo) checkout.buyerInfo = { ...checkout.buyerInfo, ...patch.buyerInfo };
  if (patch.billingInfo) checkout.billingInfo = patch.billingInfo;
  if (patch.shippingInfo) checkout.shippingInfo = { ...checkout.shippingInfo, ...patch.shippingInfo };
  if (patch.couponCode !== undefined) {
    const known = coupons.some(
      (cp: any) => cp.specification.code.toLowerCase() === String(patch.couponCode).toLowerCase(),
    );
    if (!known) return wixError(c, 400, `Coupon not found: ${patch.couponCode}`, 'ERROR_COUPON_DOES_NOT_EXIST');
    checkout.couponCode = patch.couponCode;
  }
  if (checkout.shippingInfo.shippingDestination?.address) {
    checkout.shippingInfo.carrierServiceOptions = carrierServiceOptions(checkout);
  }
  reprice(checkout);
  return c.json({ checkout });
});

app.post('/ecom/v1/checkouts/:id/create-order', (c) => {
  const checkout = checkouts.get(c.req.param('id'));
  if (!checkout) return wixError(c, 404, 'Checkout not found', 'NOT_FOUND');
  if (!checkout.shippingInfo?.shippingDestination?.address) {
    return wixError(c, 400, 'shippingDestination.address is required to create an order');
  }
  if (!checkout.shippingInfo?.selectedCarrierServiceOption) {
    return wixError(c, 400, 'selectedCarrierServiceOption is required to create an order');
  }
  reprice(checkout);
  const order = {
    id: randomUUID(),
    number: String(1000 + orders.size + 1),
    checkoutId: checkout.id,
    paymentStatus: 'NOT_PAID',
    fulfillmentStatus: 'NOT_FULFILLED',
    priceSummary: checkout.priceSummary,
    buyerInfo: checkout.buyerInfo,
    billingInfo: checkout.billingInfo,
    shippingInfo: checkout.shippingInfo,
    lineItems: checkout.lineItems,
    payments: [] as any[],
  };
  orders.set(order.id, order);
  checkout.completed = true;
  return c.json({ orderId: order.id });
});

// -- Order Transactions: Add Payments ---------------------------------------------------

app.post('/ecom/v1/payments/orders/:id/add-payment', async (c) => {
  const order = orders.get(c.req.param('id'));
  if (!order) return wixError(c, 404, 'Order not found', 'NOT_FOUND');
  const payments = (await c.req.json().catch(() => ({})))?.payments ?? [];
  const seen = new Set(order.payments.map((p: any) => p.regularPaymentDetails?.providerTransactionId));
  // Duplicate providerTransactionId fails the whole call, like real Wix.
  for (const p of payments) {
    const txn = p.regularPaymentDetails?.providerTransactionId;
    if (txn && seen.has(txn)) {
      return wixError(c, 400, `Duplicate providerTransactionId: ${txn}`, 'DUPLICATE_PAYMENT');
    }
    if (txn) seen.add(txn);
  }
  order.payments.push(...payments.map((p: any) => ({ id: randomUUID(), ...p })));
  // paymentStatus recalculates async — hold PENDING briefly, then settle.
  order.paymentStatus = 'PENDING';
  setTimeout(() => {
    const paid = order.payments.reduce((sum: number, p: any) => sum + Number(p.amount?.amount ?? 0), 0);
    order.paymentStatus = paid >= Number(order.priceSummary.total.amount) ? 'PAID' : 'PARTIALLY_PAID';
  }, 250);
  return c.json({
    orderTransactions: {
      orderId: order.id,
      payments: order.payments,
    },
  });
});

app.get('/ecom/v1/orders/:id', (c) => {
  const order = orders.get(c.req.param('id'));
  if (!order) return wixError(c, 404, 'Order not found', 'NOT_FOUND');
  return c.json({ order });
});

// -- debug (not Wix endpoints) -----------------------------------------------------------

app.get('/_orders', (c) => c.json([...orders.values()]));

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** Sign a Wix-style webhook JWT: claims.data and event.data are JSON strings. */
function webhookJwt(eventType: string, entityId: string, data: any, instanceId = 'mock-instance'): string {
  const event = {
    eventType,
    instanceId,
    entityId,
    eventTime: new Date().toISOString(),
    data: JSON.stringify(data),
  };
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ data: JSON.stringify(event), iat: now, exp: now + 3600 }));
  const sign = createSign('RSA-SHA256');
  sign.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(sign.sign(WEBHOOK_KEY))}`;
}

// POST {url, eventType?, orderId?, instanceId?} -> signs + delivers the JWT like
// Wix would. App lifecycle events (AppInstalled / AppRemoved) need no orderId.
app.post('/_emit-webhook', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const eventType = body.eventType ?? 'wix.ecom.v1.fulfillments_updated';
  const instanceId = body.instanceId ?? 'mock-instance';
  if (!body.url) return c.json({ error: 'url is required' }, 400);
  let jwt: string;
  if (/^App(Installed|Removed)$/.test(eventType)) {
    jwt = webhookJwt(eventType, instanceId, { appId: APP_ID }, instanceId);
  } else {
    const order = orders.get(String(body.orderId ?? ''));
    if (!order) return c.json({ error: 'a known orderId is required' }, 400);
    // Real Wix shapes: inner data carries entityId (= order id) + updatedEvent.currentEntity.
    const data = eventType.includes('fulfillment')
      ? {
          id: randomUUID(),
          entityFqdn: 'wix.ecom.v1.fulfillments',
          slug: 'updated',
          entityId: order.id,
          updatedEvent: {
            currentEntity: {
              orderId: order.id,
              fulfillments: [
                {
                  id: randomUUID(),
                  lineItems: order.lineItems.map((li: any) => ({ id: li.id, quantity: li.quantity })),
                  trackingInfo: { trackingNumber: 'MOCK123', shippingProvider: 'usps' },
                },
              ],
            },
          },
        }
      : { id: randomUUID(), entityFqdn: 'wix.ecom.v1.order', slug: eventType.split('_').pop(), entityId: order.id, updatedEvent: { currentEntity: order } };
    jwt = webhookJwt(eventType, order.id, data, instanceId);
  }
  const res = await fetch(body.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: jwt,
  });
  return c.json({ delivered: res.status, response: await res.json().catch(() => null) });
});

const port = Number(process.env.PORT ?? 8789);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mock-wix listening on http://localhost:${info.port} (token: ${TOKEN}, site: ${SITE_ID})`);
});
