/**
 * Seed the flower-shop conformance fixtures on a REAL Wix site and emit the
 * live conformance config for it.
 *
 *   npx tsx --env-file=.env scripts/wix-seed.ts <tenantId>
 *
 * Idempotent: products are matched by SKU, coupons by code, contacts by email.
 * Needs app scopes: Manage Products (Catalog V3 + inventory), Manage Coupons,
 * Manage Contacts, plus eCom for the shipping quote. Shipping rules themselves
 * are configured by the merchant in the dashboard; this script only reads the
 * resulting carrier option codes for the two fixture destinations.
 *
 * Writes config/live/<tenantId>/{conformance_input,test_fixtures}.json with
 * the site's real product ids and shipping option codes. Run the suite with
 *   SERVER_URL=<origin>/<tenantId> SIMULATION_SECRET=<secret> \
 *   CONFORMANCE_INPUT=.../conformance_input.json FIXTURE_CONFIG=.../test_fixtures.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.UCP_NO_LISTEN = '1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
await import('../src/index.js'); // Node storage + seeds
const { tenantFor } = await import('../src/tenants.js');
const { wix, WIX_STORES_APP_ID } = await import('../src/adapters/wix.js');

const tenantId = process.argv[2];
if (!tenantId) {
  console.error('usage: tsx --env-file=.env scripts/wix-seed.ts <tenantId>');
  process.exit(2);
}
const found = tenantFor({ req: { url: 'http://localhost/', header: () => undefined } } as any, tenantId);
if (!found) {
  console.error(`unknown tenant ${tenantId}`);
  process.exit(2);
}
const tenant = found;
const fixtures = JSON.parse(readFileSync(join(ROOT, 'config', 'fixtures.json'), 'utf8'));
const dollars = (minor: number) => (minor / 100).toFixed(2);
const fail = (what: string, status: number, body: any) =>
  `${what}: HTTP ${status}${body?.message ? ` ${String(body.message).split('\n')[0]}` : ''}`;

// -- products (Catalog V3) -----------------------------------------------------------------

const productIds: Record<string, string> = {};
{
  const [qs, list] = await wix(tenant, 'POST', '/stores/v3/products/query', {
    query: { cursorPaging: { limit: 100 } },
  });
  if (qs >= 400) console.error(fail('query products', qs, list));
  // Query omits variant data; SKU lives on the variant, so fetch each product.
  const bySku = new Map<string, string>();
  for (const p of list?.products ?? []) {
    const [, full] = await wix(tenant, 'GET', `/stores/v3/products/${p.id}`);
    for (const v of full?.product?.variantsInfo?.variants ?? []) if (v.sku) bySku.set(v.sku, p.id);
  }
  for (const f of fixtures.products) {
    let id = bySku.get(f.id);
    if (!id) {
      const [s, created] = await wix(tenant, 'POST', '/stores/v3/products', {
        product: {
          name: f.title,
          productType: 'PHYSICAL',
          physicalProperties: {},
          visible: true,
          variantsInfo: {
            variants: [
              { sku: f.id, choices: [], price: { actualPrice: { amount: dollars(f.price) } }, physicalProperties: {} },
            ],
          },
        },
      });
      if (s >= 400) {
        console.error(fail(`create product ${f.id}`, s, created));
        continue;
      }
      id = created.product.id as string;
      console.log(`created product ${f.id} -> ${id}`);
    } else console.log(`product ${f.id} exists -> ${id}`);
    productIds[f.id] = id;
    // Inventory: quantity-tracked at the fixture level (0 for the out-of-stock item).
    // The inventory item appears a moment after product creation; poll briefly.
    let item: any;
    let is = 0;
    for (let attempt = 0; attempt < 6 && !item; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000));
      const [status, inv] = await wix(tenant, 'POST', '/stores/v3/inventory-items/query', {
        query: { filter: { productId: id }, cursorPaging: { limit: 1 } },
      });
      is = status;
      item = inv?.inventoryItems?.[0];
    }
    if (!item) {
      // Create Product does not create inventory; create the item (default location) with the stock.
      const [, full] = await wix(tenant, 'GET', `/stores/v3/products/${id}`);
      const variantId = full?.product?.variantsInfo?.variants?.[0]?.id;
      const [cs, created] = await wix(tenant, 'POST', '/stores/v3/inventory-items', {
        inventoryItem: { productId: id, variantId, quantity: f.stock },
      });
      if (cs >= 400) console.error(fail(`create inventory ${f.id}`, cs, created));
      else console.log(`inventory ${f.id} created with quantity ${f.stock}`);
      continue;
    }
    if (item.quantity !== f.stock || !item.trackQuantity) {
      const [us, upd] = await wix(tenant, 'PATCH', `/stores/v3/inventory-items/${item.id}`, {
        inventoryItem: { id: item.id, revision: item.revision, quantity: f.stock },
        reason: 'MANUAL',
      });
      if (us >= 400) console.error(fail(`set stock ${f.id}=${f.stock}`, us, upd));
      else console.log(`stock ${f.id} = ${f.stock}`);
    }
  }
}

// -- coupons (Coupons V2) -------------------------------------------------------------------

{
  const [qs, list] = await wix(tenant, 'POST', '/stores/v2/coupons/query', { query: {} });
  if (qs >= 400) console.error(fail('query coupons', qs, list));
  const have = new Set((list?.coupons ?? []).map((c: any) => String(c.specification?.code).toUpperCase()));
  for (const d of fixtures.discounts) {
    if (have.has(d.code.toUpperCase())) {
      console.log(`coupon ${d.code} exists`);
      continue;
    }
    const spec: any = {
      name: d.title,
      code: d.code,
      active: true,
      startTime: String(Date.now() - 60_000),
      scope: { namespace: 'stores' },
    };
    if (d.type === 'percentage') spec.percentOffRate = d.value;
    else spec.moneyOffAmount = d.value / 100;
    const [s, created] = await wix(tenant, 'POST', '/stores/v2/coupons', { specification: spec });
    if (s >= 400) console.error(fail(`create coupon ${d.code}`, s, created));
    else console.log(`created coupon ${d.code}`);
  }
}

// -- contacts (Contacts V4) -----------------------------------------------------------------

for (const c of fixtures.customers) {
  const [qs, found] = await wix(tenant, 'POST', '/contacts/v4/contacts/query', {
    query: { filter: { 'info.emails.email': { $eq: c.email } } },
  });
  if (qs >= 400) {
    console.error(fail(`query contact ${c.email}`, qs, found));
    continue;
  }
  if (found?.contacts?.length) {
    console.log(`contact ${c.email} exists`);
    continue;
  }
  const [first, ...rest] = String(c.name).split(' ');
  const [s, created] = await wix(tenant, 'POST', '/contacts/v4/contacts', {
    info: {
      name: { first, last: rest.join(' ') },
      emails: { items: [{ tag: 'MAIN', email: c.email }] },
      addresses: {
        items: c.addresses.map((a: any) => ({
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
  });
  if (s >= 400) console.error(fail(`create contact ${c.email}`, s, created));
  else console.log(`created contact ${c.email}`);
}

// -- shipping option codes for the fixture destinations -----------------------------------

async function optionsFor(dest: any): Promise<{ code: string; title: string; amount: string }[]> {
  const roses = productIds['bouquet_roses'];
  if (!roses) return [];
  const [cs, co] = await wix(tenant, 'POST', '/ecom/v1/checkouts', {
    channelType: 'OTHER_PLATFORM',
    lineItems: [{ quantity: 1, catalogReference: { appId: WIX_STORES_APP_ID, catalogItemId: roses } }],
  });
  if (cs >= 400) return [];
  const [, up] = await wix(tenant, 'PATCH', `/ecom/v1/checkouts/${co.checkout.id}`, {
    checkout: {
      shippingInfo: {
        shippingDestination: {
          address: {
            country: dest.address_country,
            subdivision: `${dest.address_country}-${dest.address_region}`,
            city: dest.address_locality,
            postalCode: dest.postal_code,
            addressLine: dest.street_address,
          },
          contactDetails: { firstName: 'Fixture', lastName: 'Probe' },
        },
      },
    },
  });
  return (up?.checkout?.shippingInfo?.carrierServiceOptions ?? []).flatMap((c: any) =>
    (c.shippingOptions ?? []).map((o: any) => ({ code: o.code, title: o.title, amount: o.cost?.price?.amount })),
  );
}

const base = JSON.parse(readFileSync(join(ROOT, 'config', 'test_fixtures.json'), 'utf8'));
const dyn = base.test_fixtures.dynamic_fulfillment;
const domestic = await optionsFor(dyn.domestic.destination);
const international = await optionsFor(dyn.international.destination);
console.log('domestic options:', JSON.stringify(domestic));
console.log('international options:', JSON.stringify(international));
const pick = (opts: any[], re: RegExp) => (opts.find((o) => re.test(o.title)) ?? opts[0])?.code;

// -- live config --------------------------------------------------------------------------

const outDir = join(ROOT, 'config', 'live', tenantId);
mkdirSync(outDir, { recursive: true });
const input = JSON.parse(readFileSync(join(ROOT, 'config', 'conformance_input.json'), 'utf8'));
input.items[0].id = productIds['bouquet_roses'] ?? input.items[0].id;
input.out_of_stock_item.id = productIds['gardenias'] ?? input.out_of_stock_item.id;
writeFileSync(join(outDir, 'conformance_input.json'), JSON.stringify(input, null, 2) + '\n');

base.test_fixtures.valid_item.sku = productIds['bouquet_roses'] ?? base.test_fixtures.valid_item.sku;
if (domestic.length) dyn.domestic.expected_option_id = pick(domestic, /express/i);
if (international.length) dyn.international.expected_option_id = pick(international, /international|express/i);
writeFileSync(join(outDir, 'test_fixtures.json'), JSON.stringify(base, null, 2) + '\n');
console.log(`wrote ${outDir}/{conformance_input,test_fixtures}.json`);
if (!domestic.length || !international.length) {
  console.error('WARNING: no shipping options quoted for a fixture destination — check the site shipping rules');
}
