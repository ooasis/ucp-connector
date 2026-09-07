/**
 * Merchant UCP profile: capability declarations, business profile document,
 * checkout response envelope, and the platform-profile fetch used for webhook
 * discovery and signature keys. Port of the Magento Profile model.
 */

import { isIP } from 'node:net';
import { IS_WORKERS } from './runtime.js';
import type { Tenant } from './tenants.js';
import { publishedKeys } from './tenants.js';
import { ucpHandlers } from './payments.js';

export const VERSION = '2026-04-08';

export const CAPABILITIES: Record<string, Record<string, any>> = {
  'dev.ucp.shopping.checkout': {},
  'dev.ucp.shopping.order': {},
  'dev.ucp.shopping.discount': { extends: ['dev.ucp.shopping.checkout'] },
  'dev.ucp.shopping.fulfillment': { extends: 'dev.ucp.shopping.checkout' },
  'dev.ucp.shopping.buyer_consent': { extends: 'dev.ucp.shopping.checkout' },
};

/** The UCP REST endpoint URL for a tenant. */
export function endpoint(tenant: Tenant): string {
  return `${tenant.baseUrl}/ucp`;
}

/** Capability entries (version/spec/schema) for the business profile. */
function capabilityEntries(): Record<string, any[]> {
  const caps: Record<string, any[]> = {};
  for (const [name, extra] of Object.entries(CAPABILITIES)) {
    const short = name.replace('dev.ucp.shopping.', '');
    caps[name] = [
      {
        version: VERSION,
        spec: `https://ucp.dev/${VERSION}/specification/${short.replace(/_/g, '-')}`,
        schema: `https://ucp.dev/${VERSION}/schemas/shopping/${short}.json`,
        ...extra,
      },
    ];
  }
  return caps;
}

/** The merchant business profile served at /{tenant}/.well-known/ucp. */
export async function businessProfile(tenant: Tenant): Promise<any> {
  const keys = await publishedKeys(tenant.id);
  return {
    ucp: {
      version: VERSION,
      services: {
        'dev.ucp.shopping': [
          {
            version: VERSION,
            spec: `https://ucp.dev/${VERSION}/specification/overview`,
            transport: 'rest',
            endpoint: endpoint(tenant),
            schema: `https://ucp.dev/${VERSION}/services/shopping/openapi.json`,
          },
        ],
      },
      capabilities: capabilityEntries(),
      payment_handlers: ucpHandlers(tenant),
      keys,
    },
    signing_keys: keys,
  };
}

/** The `ucp` envelope embedded in checkout responses. */
export function responseEnvelope(tenant: Tenant): any {
  const caps: Record<string, any[]> = {};
  for (const name of Object.keys(CAPABILITIES)) {
    caps[name] = [{ name, version: VERSION }];
  }
  return {
    version: VERSION,
    capabilities: caps,
    payment_handlers: ucpHandlers(tenant),
  };
}

// -- SSRF guard -----------------------------------------------------------------

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isPublicIp(ip: string): boolean {
  if (isIP(ip) === 4) return !PRIVATE_V4.test(ip);
  const v6 = ip.toLowerCase();
  return !(v6 === '::1' || v6 === '::' || v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('::ffff:'));
}

/**
 * Guards outbound requests to attacker-influenced URLs (platform profile
 * fetches, order webhooks) against SSRF into private/internal networks.
 * ponytail: resolve-then-fetch leaves a DNS-rebinding window; pin the resolved
 * IP into the HTTP client when hardening further.
 */
export async function isPublicUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPublicIp(host);
  // Workers cannot resolve DNS here, and the platform already refuses fetches
  // to private/internal addresses, so the hostname check is done by the runtime.
  if (IS_WORKERS) return true;
  try {
    const { lookup } = await import('node:dns/promises');
    const { address } = await lookup(host);
    return isPublicIp(address);
  } catch {
    return false; // unresolvable
  }
}

// -- platform profile fetch --------------------------------------------------------

const profileCache = new Map<string, { profile: any; expires: number }>();

/** Fetch + cache the platform profile named in the UCP-Agent header. Failure is non-fatal. */
export async function fetchPlatformProfile(
  tenant: Tenant,
  ucpAgent: string,
): Promise<any | null> {
  const m = ucpAgent.match(/profile="([^"]+)"/);
  if (!m) return null;
  const url = m[1];
  // Agent-supplied URL: refuse private/internal targets (SSRF) outside test
  // mode — the conformance suite's mock servers are on private IPs.
  if (!tenant.config.simulationSecret && !(await isPublicUrl(url))) return null;
  const cached = profileCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.profile;
  try {
    // redirect: 'manual' — a 3xx could bounce past the isPublicUrl check (SSRF).
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (res.status !== 200) return null;
    const profile = await res.json();
    if (profile && typeof profile === 'object') {
      profileCache.set(url, { profile, expires: Date.now() + 300_000 });
      return profile;
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

/** Extract the order webhook URL from a platform profile (first capability config that has one). */
export function webhookUrlFromProfile(profile: any | null): string | null {
  const caps = profile?.ucp?.capabilities ?? {};
  for (const entries of Object.values(caps)) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (entry?.config?.webhook_url) return entry.config.webhook_url;
    }
  }
  return null;
}
