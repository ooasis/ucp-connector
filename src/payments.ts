/**
 * Payment handler registry (port of the conformance-proven Magento/Woo one).
 *
 * Handlers:
 *  - mock_payment_handler — token semantics for testing/conformance; advertised
 *    and chargeable only while a simulation secret is configured (test mode).
 *  - google_pay (UCP com.google.pay) — Google Pay instruments tokenized with
 *    gateway=stripe; charged as a Stripe PaymentIntent via direct form-encoded
 *    HTTP (no Stripe SDK dependency).
 *  - card_tokenized (ACP dev.acp.tokenized.card) — Stripe Shared Payment
 *    Tokens; charged via shared_payment_granted_token.
 */

import { UcpError } from './errors.js';
import { VERSION } from './profile.js';
import type { Tenant } from './tenants.js';

/** Charge an instrument. Returns a PSP transaction id, or null (mock). Throws UcpError. */
export async function charge(
  tenant: Tenant,
  instrument: any,
  amount: number,
  currency: string,
): Promise<string | null> {
  const cred = instrument?.credential ?? {};
  switch (instrument?.handler_id ?? '') {
    case 'mock_payment_handler':
      // Chargeable only while advertised (test mode): otherwise a production
      // agent could "pay" with mock tokens for free.
      if (!tenant.config.simulationSecret) {
        throw new UcpError(400, 'INVALID_REQUEST', 'Unknown payment handler mock_payment_handler');
      }
      chargeMock(cred);
      return null;
    case 'google_pay': {
      // Two calls: tok_ -> PaymentMethod -> confirmed PaymentIntent.
      const pm = await stripeRequest(tenant, '/v1/payment_methods', {
        type: 'card',
        card: { token: gpayStripeToken(cred.token ?? '') },
      });
      return chargeStripe(tenant, { payment_method: pm.id ?? '' }, amount, currency);
    }
    case 'card_tokenized':
      // Stripe Shared Payment Token: documented one-call preview shape.
      return chargeStripe(
        tenant,
        { payment_method_data: { shared_payment_granted_token: cred.token ?? '' } },
        amount,
        currency,
      );
  }
  throw new UcpError(400, 'INVALID_REQUEST', `Unknown payment handler ${instrument?.handler_id ?? ''}`);
}

export function isKnownHandler(handlerId: string): boolean {
  return ['mock_payment_handler', 'google_pay', 'card_tokenized'].includes(handlerId);
}

// -- mock -------------------------------------------------------------------------

/** Mock handler token semantics: success, insufficient funds, fraud, unknown. */
function chargeMock(cred: any): void {
  if ((cred.type ?? '') === 'card') return; // mock: any raw card succeeds
  switch (cred.token ?? '') {
    case 'success_token':
      return;
    case 'fail_token':
      throw new UcpError(402, 'INSUFFICIENT_FUNDS', 'Payment Failed: Insufficient Funds (Mock)');
    case 'fraud_token':
      throw new UcpError(403, 'FRAUD_DETECTED', 'Payment Failed: Fraud Detected (Mock)');
    default:
      throw new UcpError(402, 'UNKNOWN_TOKEN', 'Payment Failed: Unknown Token (Mock)');
  }
}

// -- Stripe (direct form-encoded API) -----------------------------------------------

/** GPay tokenizationData.token for gateway=stripe is a JSON Stripe Token object (or a bare tok_). */
function gpayStripeToken(token: string): string {
  try {
    const parsed = JSON.parse(token);
    if (parsed && typeof parsed === 'object' && parsed.id) return parsed.id;
  } catch {
    /* bare token */
  }
  return token;
}

async function chargeStripe(
  tenant: Tenant,
  params: Record<string, any>,
  amount: number,
  currency: string,
): Promise<string> {
  const [http, body] = await stripeRequestRaw(tenant, '/v1/payment_intents', {
    ...params,
    amount,
    currency: currency.toLowerCase(),
    confirm: 'true',
    // Agent checkouts are server-to-server: redirect-based methods are impossible.
    automatic_payment_methods: { enabled: 'true', allow_redirects: 'never' },
  });
  return mapStripeResponse(http, body);
}

/** Flatten nested params into Stripe's form encoding (card[token]=...). */
function formEncode(params: Record<string, any>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') formEncode(v, key, out);
    else out.set(key, String(v));
  }
  return out;
}

async function stripeRequestRaw(
  tenant: Tenant,
  path: string,
  params: Record<string, any>,
): Promise<[number, any]> {
  const key = tenant.config.stripeSecretKey;
  if (!key) throw new UcpError(400, 'INVALID_REQUEST', 'Stripe is not configured on this store');
  let res: Response;
  try {
    res = await fetch(tenant.config.stripeApiBase.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formEncode(params).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new UcpError(502, 'PAYMENT_FAILED', `Payment processor unreachable: ${e?.message ?? e}`);
  }
  const body = (await res.json().catch(() => ({}))) ?? {};
  return [res.status, body];
}

async function stripeRequest(tenant: Tenant, path: string, params: Record<string, any>): Promise<any> {
  const [http, body] = await stripeRequestRaw(tenant, path, params);
  if (http >= 400 || body.error) {
    mapStripeResponse(http, body); // throws with the right classification
  }
  return body;
}

/** Split out so decline mapping is unit-testable without a network. */
export function mapStripeResponse(http: number, body: any): string {
  if (http < 400 && body.id) {
    const status = body.status ?? 'succeeded';
    if (['succeeded', 'processing', 'requires_capture'].includes(status)) return body.id;
    throw new UcpError(
      402,
      'PAYMENT_DECLINED',
      `Payment not completed: intent status ${status}`,
      'requires_buyer_input',
    );
  }
  const err = body.error ?? {};
  if ((err.type ?? '') === 'card_error') {
    const reason = err.decline_code ?? err.code ?? 'card_declined';
    throw new UcpError(
      402,
      'PAYMENT_DECLINED',
      `Payment declined: ${reason} — ${err.message ?? ''}`,
      'requires_buyer_input',
    );
  }
  throw new UcpError(502, 'PAYMENT_FAILED', `Payment processor error: ${err.message ?? `HTTP ${http}`}`);
}

// -- handler advertisements -----------------------------------------------------------

/** The payment_handlers map for the UCP business profile and checkout response envelope. */
export function ucpHandlers(tenant: Tenant): Record<string, any[]> {
  const handlers: Record<string, any[]> = {};
  if (tenant.config.simulationSecret) {
    handlers['dev.mock.payment_handler'] = [
      {
        id: 'mock_payment_handler',
        name: 'mock_payment_handler',
        version: VERSION,
        spec: `https://ucp.dev/${VERSION}/schemas/mock_payment_handler/spec`,
        config: { mode: 'mock' },
      },
    ];
  }
  if (tenant.config.stripeSecretKey) {
    const gateway: Record<string, string> = { gateway: 'stripe' };
    if (tenant.config.stripePublishableKey) {
      gateway['stripe:version'] = '2018-10-31';
      gateway['stripe:publishableKey'] = tenant.config.stripePublishableKey;
    }
    handlers['com.google.pay'] = [
      {
        id: 'google_pay',
        name: 'com.google.pay',
        version: VERSION,
        spec: 'https://developers.google.com/merchant/ucp/guides/google-pay-payment-handler',
        config_schema: `https://pay.google.com/gp/p/ucp/${VERSION}/schemas/config.json`,
        instrument_schemas: [
          `https://pay.google.com/gp/p/ucp/${VERSION}/schemas/card_payment_instrument.json`,
        ],
        config: {
          api_version: 2,
          api_version_minor: 0,
          merchant_info: {
            merchant_name: tenant.config.merchantName,
            merchant_id: 'TEST',
            merchant_origin: new URL(tenant.baseUrl).host,
          },
          allowed_payment_methods: [
            {
              type: 'CARD',
              parameters: {
                allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
                allowedCardNetworks: ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'],
              },
              tokenization_specification: [
                { type: 'PAYMENT_GATEWAY', parameters: [gateway] },
              ],
            },
          ],
        },
      },
    ];
  }
  return handlers;
}

/** handlers list for ACP session capabilities.payment.handlers. */
export function acpHandlers(tenant: Tenant): any[] {
  const handlers: any[] = [];
  if (tenant.config.stripeSecretKey) {
    handlers.push({
      id: 'card_tokenized',
      name: 'dev.acp.tokenized.card',
      version: '2026-01-22',
      spec: 'https://acp.dev/handlers/tokenized.card',
      requires_delegate_payment: true,
      requires_pci_compliance: false,
      psp: 'stripe',
      config_schema: 'https://acp.dev/schemas/handlers/tokenized.card/config.json',
      instrument_schemas: ['https://acp.dev/schemas/handlers/tokenized.card/instrument.json'],
      config: {
        merchant_id: tenant.config.stripeAccountId,
        psp: 'stripe',
        accepted_brands: ['visa', 'mastercard', 'amex', 'discover'],
        supports_3ds: false,
        environment: tenant.config.stripeSecretKey.startsWith('sk_test') ? 'test' : 'production',
      },
    });
  }
  if (tenant.config.simulationSecret) {
    handlers.push({
      id: 'mock_payment_handler',
      name: 'mock_payment_handler',
      version: VERSION,
      spec: `https://ucp.dev/${VERSION}/schemas/mock_payment_handler/spec`,
      requires_delegate_payment: false,
      requires_pci_compliance: false,
      psp: 'mock',
      config_schema: '',
      instrument_schemas: [],
      config: { mode: 'mock' },
    });
  }
  return handlers;
}
