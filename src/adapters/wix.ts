/**
 * Wix PlatformAdapter (plan phase 3, wix/PLAN.md), built on Cart V2 semantics:
 * one unified cart+checkout entity created with line items, mutated via Update
 * Checkout (addresses, coupon code, selectedCarrierServiceOption), then Create
 * Order From Checkout. Payment is charged upstream (Stripe) and recorded via
 * Order Transactions Add Payments (dedupes on provider transaction id;
 * paymentStatus recalculates async, so we poll before returning).
 *
 * Catalog via Wix Stores Catalog V3 Get Product (+ Inventory Items V3 for
 * quantities), falling back to Catalog V1 on sites that still run it (Wix
 * answers 428 CATALOG_V3_CALLING_CATALOG_V1_API and vice versa); item ids are
 * V3 product ids, optionally `productId:variantId` for a specific variant.
 * Coupons via Coupons V2 Query, known buyers via Contacts Query. Tenant config: wixApiBase (mock override), wixSiteId,
 * wixWebhookPublicKey (per-tenant inbound webhook key, dev/legacy) and either
 * wixInstanceId (app instance: 4 h client_credentials tokens under
 * WIX_APP_ID/WIX_APP_SECRET, cached here) or a static wixAccessToken.
 */

import { createVerify } from 'node:crypto';
import { UcpError } from '../errors.js';
import type { Tenant, TenantConfig } from '../tenants.js';
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

const tokenCache = new Map<string, { token: string; exp: number }>();

/** App-instance access token (client_credentials, 4 h), or the static dev token. */
async function accessToken(cfg: TenantConfig): Promise<string> {
  const id = cfg.wixInstanceId;
  if (!id) return cfg.wixAccessToken;
  const hit = tokenCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.token;
  let res: Response;
  try {
    res = await fetch(`${cfg.wixApiBase.replace(/\/$/, '')}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: process.env.WIX_APP_ID ?? '',
        client_secret: process.env.WIX_APP_SECRET ?? '',
        instance_id: id,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new UcpError(502, 'INTERNAL_ERROR', `Wix unreachable: ${e?.message ?? e}`);
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    throw new UcpError(502, 'INTERNAL_ERROR', `Wix token request failed (HTTP ${res.status})`);
  }
  const ttl = (Number(json.expires_in) || 14_400) * 1000;
  tokenCache.set(id, { token: json.access_token, exp: Date.now() + ttl - 60_000 });
  return json.access_token;
}

export async function wix(
  tenant: Tenant,
  method: string,
  path: string,
  body?: any,
): Promise<[number, any]> {
  const cfg = tenant.config;
  if (!cfg.wixInstanceId && (!cfg.wixSiteId || !cfg.wixAccessToken)) {
    throw new UcpError(500, 'INTERNAL_ERROR', 'Wix is not configured on this tenant');
  }
  const url = `${cfg.wixApiBase.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    Authorization: await accessToken(cfg),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (cfg.wixSiteId) headers['wix-site-id'] = cfg.wixSiteId;
  // Wix rate-limits per app instance (429); one short retry covers bursts
  // without blowing the caller's timeout budget.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix unreachable: ${e?.message ?? e}`);
    }
    if (res.status === 429 && attempt < 1) {
      const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 1000, 2000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    return [res.status, await res.json().catch(() => null)];
  }
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

/** Wix validates phone format even when empty: send only the fields we have. */
function contactDetails(dest: Destination, buyer?: any): any {
  const out: Record<string, string> = {};
  const first = buyer?.first_name ?? dest.first_name;
  const last = buyer?.last_name ?? dest.last_name;
  const phone = buyer?.phone_number ?? dest.phone_number;
  if (first) out.firstName = first;
  if (last) out.lastName = last;
  if (phone) out.phone = phone;
  return out;
}

/** Wix error message (validation errors carry the field path) for diagnostics. */
const wixMessage = (body: any): string => (body?.message ? `: ${String(body.message).split('\n')[0]}` : '');

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

/** Sites that answered 428 to a V3 call: use Catalog V1 for them from then on. */
const catalogV1Sites = new Set<string>();

/**
 * Checkouts created for shipping quotes, reused by createOrder for the same
 * items + destination so completion needs 3 Wix calls instead of 6 (real Wix
 * takes ~1 s per call; agents time out around 5 s). Wix checkouts live
 * server-side until they expire, so a stale entry just falls back to a fresh one.
 * ponytail: in-process map — move to the session doc if the connector is ever
 * scaled to more than one node.
 */
const quoteCheckouts = new Map<string, { id: string; at: number }>();
const QUOTE_TTL_MS = 30 * 60 * 1000;

function quoteKey(tenant: Tenant, items: CartLine[], destination: Destination): string {
  const lines = [...items].sort((a, b) => a.id.localeCompare(b.id)).map((i) => `${i.id}x${i.quantity}`);
  const addr = wixAddress(destination);
  return `${tenant.id}|${lines.join(',')}|${addr.country}|${addr.subdivision ?? ''}|${addr.city}|${addr.postalCode}|${addr.addressLine}`;
}

/** `productId` or `productId:variantId` -> catalogReference for eCom line items. */
function catalogReference(itemId: string): any {
  const [catalogItemId, variantId] = itemId.split(':');
  return variantId
    ? { appId: WIX_STORES_APP_ID, catalogItemId, options: { variantId } }
    : { appId: WIX_STORES_APP_ID, catalogItemId };
}

export class WixAdapter implements PlatformAdapter {
  async getItem(tenant: Tenant, itemId: string): Promise<CatalogItem | null> {
    if (!catalogV1Sites.has(tenant.id)) {
      const v3 = await this.getItemV3(tenant, itemId);
      if (v3 !== 'v1') return v3;
      catalogV1Sites.add(tenant.id);
    }
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

  /** Catalog V3: variant price + inventory quantity; 'v1' when the site is on Catalog V1. */
  private async getItemV3(tenant: Tenant, itemId: string): Promise<CatalogItem | null | 'v1'> {
    const [productId, variantId] = itemId.split(':');
    const [status, body] = await wix(
      tenant,
      'GET',
      `/stores/v3/products/${encodeURIComponent(productId)}`,
    );
    if (status === 428) return 'v1';
    if (status === 404) return null;
    const p = body?.product;
    if (status >= 400 || !p) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix catalog lookup failed (HTTP ${status})`);
    }
    const variants: any[] = p.variantsInfo?.variants ?? [];
    const variant = variantId ? variants.find((v) => v.id === variantId) : variants[0];
    if (!variant) return null;
    let stock: number | null = variant.inventoryStatus?.inStock === false ? 0 : null;
    const [is, inv] = await wix(tenant, 'POST', '/stores/v3/inventory-items/query', {
      query: { filter: { productId, variantId: variant.id }, cursorPaging: { limit: 1 } },
    });
    const item = is < 400 ? inv?.inventoryItems?.[0] : null;
    if (item?.trackQuantity) stock = Number(item.quantity ?? 0);
    return {
      id: itemId,
      title: p.name,
      price: cents(variant.price?.actualPrice?.amount ?? p.actualPriceRange?.minValue?.amount),
      stock,
    };
  }

  /** Create a Cart V2 checkout with the line items (channelType required). */
  private async createCheckout(tenant: Tenant, items: CartLine[]): Promise<any> {
    const [status, body] = await wix(tenant, 'POST', '/ecom/v1/checkouts', {
      channelType: 'OTHER_PLATFORM',
      lineItems: items.map((i) => ({ quantity: i.quantity, catalogReference: catalogReference(i.id) })),
    });
    if (status >= 400 || !body?.checkout?.id) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix checkout creation failed (HTTP ${status}${wixMessage(body)})`);
    }
    return body.checkout;
  }

  /** Update Checkout; `extra` holds request-level fields such as `couponCode` (NOT inside checkout). */
  private async updateCheckout(tenant: Tenant, checkoutId: string, patch: any, extra: any = {}): Promise<any> {
    const [status, body] = await wix(tenant, 'PATCH', `/ecom/v1/checkouts/${checkoutId}`, {
      checkout: patch,
      ...extra,
    });
    if (status >= 400 || !body?.checkout) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix checkout update failed (HTTP ${status}${wixMessage(body)})`);
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
    quoteCheckouts.set(quoteKey(tenant, items, destination), { id: checkout.id, at: Date.now() });
    return carrierOptions(updated);
  }

  async validateDiscount(tenant: Tenant, code: string): Promise<Discount | null> {
    // Wix's coupon filter is exact-match; UCP codes are case-insensitive.
    let spec: any = null;
    for (const variant of [...new Set([code, code.toUpperCase(), code.toLowerCase()])]) {
      const [status, body] = await wix(tenant, 'POST', '/stores/v2/coupons/query', {
        query: { filter: JSON.stringify({ code: variant }) },
      });
      if (status >= 400) return null;
      spec = body?.coupons?.[0]?.specification;
      if (spec) break;
    }
    if (!spec || spec.active === false) return null;
    // Wix coupons discount line items only (verified live: 10% of $35 items +
    // $5 shipping = $3.50), so the UCP totals are computed on the same base.
    if (spec.percentOffRate != null) {
      return { code: spec.code, title: spec.name, type: 'percentage', value: Number(spec.percentOffRate), appliesTo: 'items' };
    }
    if (spec.moneyOffAmount != null) {
      return { code: spec.code, title: spec.name, type: 'fixed', value: cents(spec.moneyOffAmount), appliesTo: 'items' };
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
    const items: CartLine[] = doc.line_items.map((li: any) => ({ id: li.item.id, quantity: li.quantity }));
    const method = (doc.fulfillment?.methods ?? []).find((m: any) => m.selected_destination_id);
    const dest = (method?.destinations ?? []).find(
      (d: any) => d.id === method.selected_destination_id,
    );
    if (!dest) throw new UcpError(400, 'INVALID_REQUEST', 'No fulfillment destination selected');
    const address = wixAddress(dest);
    const contact = contactDetails(dest, doc.buyer);
    const group = (method?.groups ?? []).find((g: any) => g.selected_option_id);
    const chosen = (group?.options ?? []).find((o: any) => o.id === group.selected_option_id);
    // Wix checkouts hold ONE coupon code; apply the first (the UCP totals
    // already charged are authoritative anyway).
    const applied = doc.discounts?.applied ?? [];
    const buyerPatch = {
      buyerInfo: doc.buyer?.email ? { email: doc.buyer.email } : undefined,
      billingInfo: { address, contactDetails: contact },
    };
    const coupon = applied[0]?.code ? { couponCode: applied[0].code } : {};
    const pickOption = (checkout: any) => {
      const available = carrierOptions(checkout).sort((a, b) => a.amount - b.amount);
      return (
        available.find((o) => o.id === group?.selected_option_id) ??
        available.find((o) => o.title === chosen?.title) ??
        available[0]
      );
    };

    // Reuse the quote checkout (already carries items + destination + carrier
    // options): one PATCH with buyer, billing, coupon and the selected option.
    const key = quoteKey(tenant, items, dest);
    const quoted = quoteCheckouts.get(key);
    quoteCheckouts.delete(key);
    let checkoutId: string | null = null;
    if (quoted && Date.now() - quoted.at < QUOTE_TTL_MS) {
      try {
        const [, current] = await wix(tenant, 'GET', `/ecom/v1/checkouts/${quoted.id}`);
        const option = current?.checkout && !current.checkout.completed ? pickOption(current.checkout) : null;
        if (option) {
          await this.updateCheckout(
            tenant,
            quoted.id,
            {
              ...buyerPatch,
              shippingInfo: {
                shippingDestination: { address, contactDetails: contact },
                selectedCarrierServiceOption: { code: option.id, title: option.title },
              },
            },
            coupon,
          );
          checkoutId = quoted.id;
        }
      } catch {
        checkoutId = null; // stale/expired quote: fall through to a fresh checkout
      }
    }
    if (!checkoutId) {
      const checkout = await this.createCheckout(tenant, items);
      const withDest = await this.updateCheckout(
        tenant,
        checkout.id,
        { ...buyerPatch, shippingInfo: { shippingDestination: { address, contactDetails: contact } } },
        coupon,
      );
      const option = pickOption(withDest);
      if (option) {
        await this.updateCheckout(tenant, checkout.id, {
          shippingInfo: { selectedCarrierServiceOption: { code: option.id, title: option.title } },
        });
      }
      checkoutId = checkout.id;
    }

    const [os, order] = await wix(tenant, 'POST', `/ecom/v1/checkouts/${checkoutId}/create-order`);
    const orderId = order?.orderId;
    if (os >= 400 || !orderId) {
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix order creation failed (HTTP ${os}${wixMessage(order)})`);
    }

    // Record the external (Stripe) charge. Duplicate providerTransactionId
    // fails the whole call — exactly the dedupe we want on retries.
    const [ps, pay] = await wix(tenant, 'POST', `/ecom/v1/payments/orders/${orderId}/add-payment`, {
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
      throw new UcpError(502, 'INTERNAL_ERROR', `Wix add-payments failed (HTTP ${ps}${wixMessage(pay)})`);
    }

    // paymentStatus recalculates asynchronously on Wix's side; the Stripe
    // charge is captured and authoritative, so we do not wait for it.
    // Wix also attaches its own PENDING gateway placeholder to every order
    // created from a checkout; void it in the background so the merchant
    // sees one payment line (ours, with the Stripe id).
    void voidGatewayPlaceholder(tenant, String(orderId));
    return String(orderId);
  }
}

/** Void the PENDING gateway placeholder Wix creates on create-order (best effort). */
async function voidGatewayPlaceholder(tenant: Tenant, orderId: string): Promise<void> {
  try {
    const [, t] = await wix(tenant, 'GET', `/ecom/v1/payments/orders/${orderId}`);
    const placeholder = (t?.orderTransactions?.payments ?? []).find(
      (p: any) =>
        p.regularPaymentDetails?.status === 'PENDING' &&
        p.regularPaymentDetails?.paymentOrderId &&
        !p.regularPaymentDetails?.providerTransactionId,
    );
    if (!placeholder) return;
    const [s, r] = await wix(
      tenant,
      'POST',
      `/ecom/v1/payments/${placeholder.id}/orders/${orderId}/update-payment-transaction-status`,
      { status: 'VOIDED' },
    );
    if (s >= 400) console.warn(`wix: void placeholder payment on ${orderId} failed (HTTP ${s}${wixMessage(r)})`);
  } catch (e: any) {
    console.warn(`wix: void placeholder payment on ${orderId} failed: ${e?.message ?? e}`);
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
): { eventType: string; instanceId?: string; entityId?: string; data: any } | null {
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
    return { eventType: event.eventType ?? '', instanceId: event.instanceId, entityId: event.entityId, data };
  } catch {
    return null;
  }
}
