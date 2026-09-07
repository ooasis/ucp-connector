/**
 * PlatformAdapter: the seam between the protocol core and a commerce backend
 * (BigCommerce, Wix, ...). The StubAdapter serves flower-shop-equivalent
 * fixture data from config/fixtures.json for conformance/dev use.
 */

import fixturesJson from '../config/fixtures.json' with { type: 'json' };
import { BigCommerceAdapter } from './adapters/bigcommerce.js';
import { WixAdapter } from './adapters/wix.js';
import type { Tenant } from './tenants.js';

export type CatalogItem = {
  id: string;
  title: string;
  /** Unit price in minor units. */
  price: number;
  /** Available stock, or null when not inventory-managed. */
  stock: number | null;
};

export type Destination = {
  id: string;
  type: string;
  street_address: string;
  address_locality: string;
  address_region: string;
  postal_code: string;
  address_country: string;
  [extra: string]: any;
};

export type CartLine = {
  /** Item id/SKU. */
  id: string;
  quantity: number;
};

export type ShippingOption = {
  id: string;
  title: string;
  /** Cost in minor units. */
  amount: number;
};

export type Discount = {
  code: string;
  title: string;
  type: 'percentage' | 'fixed';
  /** Percent (0-100) or fixed minor units. */
  value: number;
  /** What the discount is computed on: items subtotal only, or items + fulfillment (default). */
  appliesTo?: 'items' | 'order';
};

export interface PlatformAdapter {
  /** Catalog lookup by item id/SKU, or null when unknown. */
  getItem(tenant: Tenant, itemId: string): Promise<CatalogItem | null>;
  /** Shipping options for a destination given the order subtotal and cart lines. */
  shippingOptions(
    tenant: Tenant,
    destination: Destination,
    subtotal: number,
    items: CartLine[],
  ): Promise<ShippingOption[]>;
  /** Resolve a discount code, or null when unknown/inapplicable. */
  validateDiscount(tenant: Tenant, code: string): Promise<Discount | null>;
  /** Stored addresses for a buyer the platform knows by email; null = unknown buyer. */
  customerAddresses(tenant: Tenant, email: string): Promise<Destination[] | null>;
  /** Materialize the order on the platform (already charged). Returns a platform ref. */
  createOrder(
    tenant: Tenant,
    doc: any,
    orderUuid: string,
    transactionId: string | null,
  ): Promise<string>;
}

// -- stub -----------------------------------------------------------------------

type Fixtures = {
  products: { id: string; title: string; price: number; stock: number | null }[];
  discounts: { code: string; title: string; type: 'percentage' | 'fixed'; value: number }[];
  customers: { name: string; email: string; addresses: Omit<Destination, 'id' | 'type'>[] }[];
  shippingRates: { id: string; country: string; price: number; title: string }[];
  freeShipping: { minSubtotal: number | null; eligibleItemIds: string[] };
};

export class StubAdapter implements PlatformAdapter {
  private fixtures: Fixtures;
  private orderSeq = 0;

  constructor(fixtures: Fixtures = fixturesJson as unknown as Fixtures) {
    this.fixtures = fixtures;
  }

  async getItem(_tenant: Tenant, itemId: string): Promise<CatalogItem | null> {
    const p = this.fixtures.products.find((p) => p.id === itemId);
    return p ? { ...p } : null;
  }

  async shippingOptions(
    _tenant: Tenant,
    destination: Destination,
    subtotal: number,
    items: CartLine[],
  ): Promise<ShippingOption[]> {
    const country = destination.address_country || 'US';
    const options: ShippingOption[] = [];
    for (const r of this.fixtures.shippingRates) {
      if (r.country === 'default' || r.country === country) {
        options.push({ id: r.id, title: r.title, amount: r.price });
      }
    }
    const fs = this.fixtures.freeShipping;
    if (
      (fs.minSubtotal != null && subtotal >= fs.minSubtotal) ||
      items.some((i) => fs.eligibleItemIds.includes(i.id))
    ) {
      options.push({ id: 'free-ship', title: 'Free Shipping', amount: 0 });
    }
    return options;
  }

  async validateDiscount(_tenant: Tenant, code: string): Promise<Discount | null> {
    const d = this.fixtures.discounts.find(
      (d) => d.code.toLowerCase() === code.toLowerCase(),
    );
    return d ? { ...d } : null;
  }

  async customerAddresses(_tenant: Tenant, email: string): Promise<Destination[] | null> {
    const c = this.fixtures.customers.find((c) => c.email === email);
    if (!c) return null;
    return c.addresses.map((a, i) => ({
      id: `addr_${email.split('@')[0]}_${i + 1}`,
      type: 'shipping_address',
      street_address: a.street_address,
      address_locality: a.address_locality,
      address_region: a.address_region,
      postal_code: a.postal_code,
      address_country: a.address_country,
    }));
  }

  async createOrder(): Promise<string> {
    return `stub-${++this.orderSeq}`;
  }
}

const adapters: Record<string, PlatformAdapter> = {};

export function adapterFor(tenant: Tenant): PlatformAdapter {
  const name = tenant.config.adapter || 'stub';
  if (name === 'stub') return (adapters.stub ??= new StubAdapter());
  if (name === 'bigcommerce') return (adapters.bigcommerce ??= new BigCommerceAdapter());
  if (name === 'wix') return (adapters.wix ??= new WixAdapter());
  throw new Error(`unknown adapter ${name}`);
}
