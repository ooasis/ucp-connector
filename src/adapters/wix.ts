/**
 * Wix PlatformAdapter (plan phase 3, wix/PLAN.md), built on Cart V2 semantics:
 * one unified cart+checkout entity created with line items, mutated via Update
 * Checkout (addresses, coupon code, selectedCarrierServiceOption), then Create
 * Order From Checkout. Payment is charged upstream (Stripe) and recorded via
 * Order Transactions Add Payments (dedupes on provider transaction id;
 * paymentStatus recalculates async, so we poll before returning).
 *
 * Catalog via Wix Stores Get Product, coupons via Coupons Query, known buyers
 * via Contacts Query. Tenant config: wixApiBase (mock override), wixSiteId,
 * wixAccessToken, wixWebhookPublicKey (inbound webhook JWT verification).
 */

import { createVerify } from 'node:crypto';
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

export const WIX_STORES_APP_ID = '215238eb-22a5-4c36-9e7b-e7c08025e04e';

/** Minor units from a Wix decimal-string amount. */
const cents = (amount: string | number | undefined): number => Math.round(Number(amount ?? 0) * 100);
/** Wix decimal-string amount from minor units. */
const dollars = (minor: number): string => (minor / 100).toFixed(2);

async function wix(
  tenant: Tenant,
  method: string,
  path: string,
  body?: any,
): Promise<[number, any]> {
  const cfg = tenant.config;
  if (!cfg.wixSiteId || !cfg.wixAccessToken) {
    throw new UcpError(500, 'INTERNAL_ERROR', 'Wix is not configured on this tenant');
  }
  const url = `${cfg.wixApiBase.replace(/\/$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: cfg.wixAccessToken,
        'wix-site-id': cfg.wixSiteId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new UcpError(502, 'INTERNAL_ERROR', `Wix unreachable: ${e?.message ?? e}`);
  }
  return [res.status, await res.json().catch(() => null)];
}

/** UCP destination -> Wix address (subdivision is ISO 3166-2, e.g. US-IL). */
function wixAddress(dest: Destination): any {
  return {
    country: dest.address_country,
    subdivision: dest.address_region ? `${dest.address_country}-${dest.address_region}` : undefined,
    city: dest.address_locality,
    postalCode: dest.postal_code,
    addressLine: dest.street_address,
    addressLine2: dest.extended_address ?? undefined,
  };
}

function contactDetails(dest: Destination, buyer?: any): any {
  return {
    firstName: buyer?.first_name ?? dest.first_name ?? '',
    lastName: buyer?.last_name ?? dest.last_name ?? '',
    phone: buyer?.phone_number ?? dest.phone_number ?? '',
  };
}

/** Flatten checkout.shippingInfo.carrierServiceOptions to UCP shipping options. */
function carrierOptions(checkout: any): ShippingOption[] {
  const out: ShippingOption[] = [];
  for (const carrier of checkout?.shippingInfo?.carrierServiceOptions ?? []) {
    for (const o of carrier.shippingOptions ?? []) {
      out.push({ id: o.code, title: o.title, amount: cents(o.cost?.price?.amount) });
    }
  }
  return out;
}

export class WixAdapter implements PlatformAdapter {
  async getItem(tenant: Tenant, itemId: string): Promise<CatalogItem | null> {
    const [status, body] = await wix(
      tenant,
      'GET',
      `/stores/v1/products/${encodeURIComponent(itemId)}`,
    );
    if (status === 404) return null;
    const p = body?.product;
    if (status >= 400 || !p) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix catalog lookup failed (HTTP ${status})`);
    }
    return {
      id: itemId,
      title: p.name,
      price: cents(p.priceData?.price),
      stock: p.stock?.trackInventory ? (p.stock?.quantity ?? 0) : null,
    };
  }

  /** Create a Cart V2 checkout with the line items (channelType required). */
  private async createCheckout(tenant: Tenant, items: CartLine[]): Promise<any> {
    const [status, body] = await wix(tenant, 'POST', '/ecom/v1/checkouts', {
      channelType: 'OTHER_PLATFORM',
      lineItems: items.map((i) => ({
        quantity: i.quantity,
        catalogReference: { appId: WIX_STORES_APP_ID, catalogItemId: i.id },
      })),
    });
    if (status >= 400 || !body?.checkout?.id) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix checkout creation failed (HTTP ${status})`);
    }
    return body.checkout;
  }

  private async updateCheckout(tenant: Tenant, checkoutId: string, patch: any): Promise<any> {
    const [status, body] = await wix(tenant, 'PATCH', `/ecom/v1/checkouts/${checkoutId}`, {
      checkout: patch,
    });
    if (status >= 400 || !body?.checkout) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix checkout update failed (HTTP ${status})`);
    }
    return body.checkout;
  }

  async shippingOptions(
    tenant: Tenant,
    destination: Destination,
    _subtotal: number,
    items: CartLine[],
  ): Promise<ShippingOption[]> {
    // Wix only quotes carrier rates on a checkout with a shipping destination,
    // so build a throwaway one (checkouts can't be deleted; Wix expires them).
    if (!items.length) return [];
    let checkout: any;
    try {
      checkout = await this.createCheckout(tenant, items);
    } catch {
      return []; // unknown items etc. — no options rather than a hard failure
    }
    const updated = await this.updateCheckout(tenant, checkout.id, {
      shippingInfo: {
        shippingDestination: { address: wixAddress(destination), contactDetails: contactDetails(destination) },
      },
    });
    return carrierOptions(updated);
  }

  async validateDiscount(tenant: Tenant, code: string): Promise<Discount | null> {
    const [status, body] = await wix(tenant, 'POST', '/stores/v1/coupons/query', {
      query: { filter: JSON.stringify({ code }) },
    });
    if (status >= 400) return null;
    const spec = body?.coupons?.[0]?.specification;
    if (!spec || spec.active === false) return null;
    if (spec.percentOffRate != null) {
      return { code: spec.code, title: spec.name, type: 'percentage', value: Number(spec.percentOffRate) };
    }
    if (spec.moneyOffAmount != null) {
      return { code: spec.code, title: spec.name, type: 'fixed', value: cents(spec.moneyOffAmount) };
    }
    return null; // freeShipping / fixedPriceAmount coupon types not supported
  }

  async customerAddresses(tenant: Tenant, email: string): Promise<Destination[] | null> {
    const [status, body] = await wix(tenant, 'POST', '/contacts/v4/contacts/query', {
      query: { filter: { 'info.emails.email': { $eq: email } } },
    });
    const contact = body?.contacts?.[0];
    if (status >= 400 || !contact) return null;
    return (contact.info?.addresses?.items ?? []).map((item: any, i: number) => {
      const a = item.address ?? {};
      return {
        id: `addr_wix_${contact.id}_${i + 1}`,
        type: 'shipping_address',
        street_address: a.addressLine ?? '',
        address_locality: a.city ?? '',
        // subdivision is ISO 3166-2 ("US-IL") — strip the country prefix.
        address_region: (a.subdivision ?? '').replace(/^[A-Z]{2}-/, ''),
        postal_code: a.postalCode ?? '',
        address_country: a.country ?? '',
      };
    });
  }

  async createOrder(
    tenant: Tenant,
    doc: any,
    orderUuid: string,
    transactionId: string | null,
  ): Promise<string> {
    const checkout = await this.createCheckout(
      tenant,
      doc.line_items.map((li: any) => ({ id: li.item.id, quantity: li.quantity })),
    );

    const method = (doc.fulfillment?.methods ?? []).find((m: any) => m.selected_destination_id);
    const dest = (method?.destinations ?? []).find(
      (d: any) => d.id === method.selected_destination_id,
    );
    if (!dest) throw new UcpError(400, 'INVALID_REQUEST', 'No fulfillment destination selected');
    const address = wixAddress(dest);
    const contact = contactDetails(dest, doc.buyer);

    // Update 1: buyer + addresses + coupon. Wix checkouts hold ONE coupon code;
    // apply the first (the UCP totals already charged are authoritative anyway).
    const applied = doc.discounts?.applied ?? [];
    const withDest = await this.updateCheckout(tenant, checkout.id, {
      buyerInfo: doc.buyer?.email ? { email: doc.buyer.email } : undefined,
      billingInfo: { address, contactDetails: contact },
      shippingInfo: { shippingDestination: { address, contactDetails: contact } },
      couponCode: applied[0]?.code,
    });

    // Update 2: selected carrier option — match by code, then title, then cheapest.
    const group = (method?.groups ?? []).find((g: any) => g.selected_option_id);
    const chosen = (group?.options ?? []).find((o: any) => o.id === group.selected_option_id);
    const available = carrierOptions(withDest).sort((a, b) => a.amount - b.amount);
    const option =
      available.find((o) => o.id === group?.selected_option_id) ??
      available.find((o) => o.title === chosen?.title) ??
      available[0];
    if (option) {
      await this.updateCheckout(tenant, checkout.id, {
        shippingInfo: { selectedCarrierServiceOption: { code: option.id, title: option.title } },
      });
    }

    const [os, order] = await wix(tenant, 'POST', `/ecom/v1/checkouts/${checkout.id}/create-order`);
    const orderId = order?.orderId;
    if (os >= 400 || !orderId) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix order creation failed (HTTP ${os})`);
    }

    // Record the external (Stripe) charge. Duplicate providerTransactionId
    // fails the whole call — exactly the dedupe we want on retries.
    const [ps] = await wix(tenant, 'POST', `/ecom/v1/payments/orders/${orderId}/payments`, {
      payments: [
        {
          amount: { amount: dollars(totalOf(doc.totals)) },
          regularPaymentDetails: {
            paymentMethod: transactionId ? 'Stripe (UCP agent)' : 'UCP (test mode)',
            providerTransactionId: transactionId ?? orderUuid,
            offlinePayment: false,
            status: 'APPROVED',
          },
        },
      ],
    });
    if (ps >= 400) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix add-payments failed (HTTP ${ps})`);
    }

    // paymentStatus recalculates async — poll until PAID before reporting.
    for (let i = 0; i < 5; i++) {
      const [, o] = await wix(tenant, 'GET', `/ecom/v1/orders/${orderId}`);
      if (o?.order?.paymentStatus === 'PAID') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // ponytail: if still not PAID after ~1s we return anyway — the Stripe
    // charge is captured and authoritative; alert on stuck orders when real.
    return String(orderId);
  }
}

/** Grand total (minor units) from a UCP totals list. */
function totalOf(totals: any[]): number {
  return Number(totals?.find((t: any) => t.type === 'total')?.amount ?? 0);
}

// -- inbound Wix webhook JWTs -----------------------------------------------------

/**
 * Verify a Wix webhook JWT (RS256, signed with the app's public key) and
 * return the parsed event: Wix wraps the payload as JSON strings twice —
 * claims.data -> { eventType, instanceId, entityId?, data: <JSON string> }.
 */
export function verifyWixWebhookJwt(
  publicKeyPem: string,
  jwt: string,
): { eventType: string; entityId?: string; data: any } | null {
  const parts = jwt.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256') return null;
    const verify = createVerify('RSA-SHA256');
    verify.update(`${parts[0]}.${parts[1]}`);
    if (!verify.verify(publicKeyPem, Buffer.from(parts[2], 'base64url'))) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (claims.exp !== undefined && claims.exp * 1000 < Date.now()) return null;
    const event = typeof claims.data === 'string' ? JSON.parse(claims.data) : claims.data;
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    return { eventType: event.eventType ?? '', entityId: event.entityId, data };
  } catch {
    return null;
  }
}
