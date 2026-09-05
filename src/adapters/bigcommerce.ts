/**
 * BigCommerce PlatformAdapter (plan phase 3, bigcommerce/PLAN.md).
 *
 * Mapping: catalog via Catalog V3 (SKU lookup), shipping rates via a throwaway
 * Carts/Checkouts V3 consignment quote, coupons via V2 Coupons, customers via
 * Customers V3, order creation via Carts -> Checkouts -> POST orders (lands
 * `incomplete`) -> PUT /v2/orders marking it paid (Stripe charged upstream).
 *
 * Tenant config: bigcommerceApiBase (mock override), bigcommerceStoreHash,
 * bigcommerceAccessToken.
 */

import { UcpError } from '../errors.js';
import type { Tenant } from '../tenants.js';
import type {
  CartLine,
  CatalogItem,
  Destination,
  Discount,
  PlatformAdapter,
  ShippingOption,
} from '../adapter.js';

type BcProduct = {
  id: number;
  name: string;
  sku: string;
  price: number; // dollars
  inventory_level: number;
  inventory_tracking: string;
};

/** Minor units from a BigCommerce dollar amount. */
const cents = (dollars: number | string): number => Math.round(Number(dollars) * 100);

async function bc(
  tenant: Tenant,
  method: string,
  path: string,
  body?: any,
): Promise<[number, any]> {
  const cfg = tenant.config;
  if (!cfg.bigcommerceStoreHash || !cfg.bigcommerceAccessToken) {
    throw new UcpError(500, 'INTERNAL_ERROR', 'BigCommerce is not configured on this tenant');
  }
  const url = `${cfg.bigcommerceApiBase.replace(/\/$/, '')}/stores/${cfg.bigcommerceStoreHash}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Auth-Token': cfg.bigcommerceAccessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new UcpError(502, 'INTERNAL_ERROR', `BigCommerce unreachable: ${e?.message ?? e}`);
  }
  // V2 returns 204 with no body for empty result sets.
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return [res.status, json];
}

/** UCP destination (+ buyer) -> BigCommerce checkout/billing address. */
function bcAddress(dest: Destination, buyer?: any): any {
  return {
    first_name: buyer?.first_name ?? dest.first_name ?? '',
    last_name: buyer?.last_name ?? dest.last_name ?? '',
    email: buyer?.email ?? '',
    address1: dest.street_address,
    address2: dest.extended_address ?? '',
    city: dest.address_locality,
    state_or_province: dest.address_region,
    state_or_province_code: dest.address_region,
    postal_code: dest.postal_code,
    country_code: dest.address_country,
    phone: dest.phone_number ?? '',
  };
}

export class BigCommerceAdapter implements PlatformAdapter {
  /** Batch SKU -> product lookup (fixture item ids are BigCommerce SKUs). */
  private async productsBySku(tenant: Tenant, skus: string[]): Promise<Map<string, BcProduct>> {
    const out = new Map<string, BcProduct>();
    if (!skus.length) return out;
    const q = [...new Set(skus)].map(encodeURIComponent).join(',');
    const [status, body] = await bc(tenant, 'GET', `/v3/catalog/products?sku:in=${q}&limit=250`);
    if (status >= 400) {
      throw new UcpError(502, 'INTERNAL_ERROR', `BigCommerce catalog lookup failed (HTTP ${status})`);
    }
    for (const p of body?.data ?? []) out.set(p.sku, p);
    return out;
  }

  async getItem(tenant: Tenant, itemId: string): Promise<CatalogItem | null> {
    const p = (await this.productsBySku(tenant, [itemId])).get(itemId);
    if (!p) return null;
    // ponytail: simple products only (product-level SKU/inventory); add a
    // /v3/catalog/variants lookup when a store with variant SKUs shows up.
    return {
      id: itemId,
      title: p.name,
      price: cents(p.price),
      stock: p.inventory_tracking === 'none' ? null : p.inventory_level,
    };
  }

  async shippingOptions(
    tenant: Tenant,
    destination: Destination,
    _subtotal: number,
    items: CartLine[],
  ): Promise<ShippingOption[]> {
    // BigCommerce only quotes rates against a real cart+consignment, so build
    // a throwaway one and delete it after (checkout id === cart id).
    const products = await this.productsBySku(tenant, items.map((i) => i.id));
    const lineItems = items
      .filter((i) => products.has(i.id))
      .map((i) => ({ product_id: products.get(i.id)!.id, quantity: i.quantity }));
    if (!lineItems.length) return [];
    const [cs, cart] = await bc(tenant, 'POST', '/v3/carts', { line_items: lineItems });
    if (cs >= 400 || !cart?.data?.id) return [];
    const cartId = cart.data.id;
    try {
      const physical = cart.data.line_items?.physical_items ?? [];
      const [, checkout] = await bc(
        tenant,
        'POST',
        `/v3/checkouts/${cartId}/consignments?include=consignments.available_shipping_options`,
        [
          {
            address: bcAddress(destination),
            line_items: physical.map((pi: any) => ({ item_id: pi.id, quantity: pi.quantity })),
          },
        ],
      );
      const options = checkout?.data?.consignments?.[0]?.available_shipping_options ?? [];
      return options.map((o: any) => ({
        id: String(o.id),
        title: o.description,
        amount: cents(o.cost),
      }));
    } finally {
      await bc(tenant, 'DELETE', `/v3/carts/${cartId}`).catch(() => {});
    }
  }

  async validateDiscount(tenant: Tenant, code: string): Promise<Discount | null> {
    const [status, body] = await bc(tenant, 'GET', `/v2/coupons?code=${encodeURIComponent(code)}`);
    const c = Array.isArray(body) ? body[0] : null;
    if (status >= 400 || !c || c.enabled === false) return null;
    if (c.type === 'percentage_discount') {
      return { code: c.code, title: c.name, type: 'percentage', value: Number(c.amount) };
    }
    if (c.type === 'per_total_discount') {
      return { code: c.code, title: c.name, type: 'fixed', value: cents(c.amount) };
    }
    return null; // per_item / free_shipping coupon types not supported
  }

  async customerAddresses(tenant: Tenant, email: string): Promise<Destination[] | null> {
    const [cs, cust] = await bc(
      tenant,
      'GET',
      `/v3/customers?email:in=${encodeURIComponent(email)}&limit=1`,
    );
    const customer = cust?.data?.[0];
    if (cs >= 400 || !customer) return null;
    const [, addrs] = await bc(
      tenant,
      'GET',
      `/v3/customers/addresses?customer_id:in=${customer.id}&limit=250`,
    );
    return (addrs?.data ?? []).map((a: any) => ({
      id: `addr_bc_${a.id}`,
      type: 'shipping_address',
      street_address: a.address1 ?? '',
      address_locality: a.city ?? '',
      address_region: a.state_or_province ?? '',
      postal_code: a.postal_code ?? '',
      address_country: a.country_code ?? '',
    }));
  }

  async createOrder(
    tenant: Tenant,
    doc: any,
    orderUuid: string,
    transactionId: string | null,
  ): Promise<string> {
    const products = await this.productsBySku(
      tenant,
      doc.line_items.map((li: any) => li.item.id),
    );
    const lineItems = doc.line_items.map((li: any) => {
      const p = products.get(li.item.id);
      if (!p) throw new UcpError(400, 'INVALID_REQUEST', `Product ${li.item.id} not found`);
      return { product_id: p.id, quantity: li.quantity };
    });
    const [cs, cart] = await bc(tenant, 'POST', '/v3/carts', { line_items: lineItems });
    if (cs >= 400 || !cart?.data?.id) {
      throw new UcpError(502, 'INTERNAL_ERROR', `BigCommerce cart creation failed (HTTP ${cs})`);
    }
    const cartId = cart.data.id;

    const method = (doc.fulfillment?.methods ?? []).find((m: any) => m.selected_destination_id);
    const dest = (method?.destinations ?? []).find(
      (d: any) => d.id === method.selected_destination_id,
    );
    if (!dest) throw new UcpError(400, 'INVALID_REQUEST', 'No fulfillment destination selected');
    const address = bcAddress(dest, doc.buyer);

    await bc(tenant, 'POST', `/v3/checkouts/${cartId}/billing-address`, address);
    const physical = cart.data.line_items?.physical_items ?? [];
    const [ccs, checkout] = await bc(
      tenant,
      'POST',
      `/v3/checkouts/${cartId}/consignments?include=consignments.available_shipping_options`,
      [
        {
          address,
          line_items: physical.map((pi: any) => ({ item_id: pi.id, quantity: pi.quantity })),
        },
      ],
    );
    const consignment = checkout?.data?.consignments?.[0];
    if (ccs >= 400 || !consignment) {
      throw new UcpError(502, 'INTERNAL_ERROR', `BigCommerce consignment failed (HTTP ${ccs})`);
    }

    // Selected shipping option: option ids can differ between the quote cart
    // and this cart, so match by id, then by title, then take the cheapest.
    const group = (method?.groups ?? []).find((g: any) => g.selected_option_id);
    const chosen = (group?.options ?? []).find((o: any) => o.id === group.selected_option_id);
    const available = [...(consignment.available_shipping_options ?? [])].sort(
      (a: any, b: any) => a.cost - b.cost,
    );
    const option =
      available.find((o: any) => String(o.id) === group?.selected_option_id) ??
      available.find((o: any) => o.description === chosen?.title) ??
      available[0];
    if (option) {
      await bc(tenant, 'PUT', `/v3/checkouts/${cartId}/consignments/${consignment.id}`, {
        shipping_option_id: String(option.id),
      });
    }

    // Best-effort coupons so the BigCommerce order total matches what was
    // charged; the Stripe charge (already captured) stays authoritative.
    for (const applied of doc.discounts?.applied ?? []) {
      await bc(tenant, 'POST', `/v3/checkouts/${cartId}/coupons`, { coupon_code: applied.code });
    }

    const [os, order] = await bc(tenant, 'POST', `/v3/checkouts/${cartId}/orders`);
    const orderId = order?.data?.id;
    if (os >= 400 || !orderId) {
      throw new UcpError(502, 'INTERNAL_ERROR', `BigCommerce order creation failed (HTTP ${os})`);
    }
    // Landed `incomplete` — mark it paid (status 11: Awaiting Fulfillment).
    await bc(tenant, 'PUT', `/v2/orders/${orderId}`, {
      status_id: 11,
      payment_method: transactionId ? 'Stripe (UCP agent)' : 'UCP (test mode)',
      payment_provider_id: transactionId ?? orderUuid,
      staff_notes: `UCP order ${orderUuid}`,
    });
    return String(orderId);
  }
}
