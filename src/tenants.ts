/**
 * Tenant registry: per-tenant config, ES256 signing keys (private JWK
 * encrypted at rest with AES-256-GCM under a master key), key rotation with
 * grace-period publication, ACP bearer key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { getDb, DATA_DIR } from './db.js';
import { ecJwkThumbprint, type Jwk } from './rfc9421.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export type TenantConfig = {
  enabled: boolean;
  merchantName: string;
  currency: string;
  /** Test mode: gates the mock payment handler and the simulate-shipping hook. */
  simulationSecret: string;
  /** Reject unsigned requests when true. */
  strictSignatures: boolean;
  stripeSecretKey: string;
  stripePublishableKey: string;
  stripeApiBase: string;
  stripeAccountId: string;
  /** ACP push webhook target, provisioned out-of-band. */
  acpWebhookUrl: string;
  acpWebhookSecret: string;
  /** Which PlatformAdapter serves this tenant ('stub' | 'bigcommerce' | 'wix'). */
  adapter: string;
  /** BigCommerce adapter: API base (mock override), store hash, V2/V3 token. */
  bigcommerceApiBase: string;
  bigcommerceStoreHash: string;
  bigcommerceAccessToken: string;
  /** Shared secret required on inbound BigCommerce store webhooks. */
  bigcommerceWebhookSecret: string;
  /** Storefront origin (from /v2/store secure_url); hosts the pushed profile page. */
  bigcommerceStorefrontUrl: string;
  /** Wix adapter: API base (mock override), site id, static token (dev/legacy). */
  wixApiBase: string;
  wixSiteId: string;
  wixAccessToken: string;
  /** App instance id: when set, tokens come from client_credentials (wix-app.ts). */
  wixInstanceId: string;
  /** Published site URL (Get App Instance), where /.well-known/ucp must be fronted. */
  wixSiteUrl: string;
  /** RSA public key (PEM) verifying inbound Wix webhook JWTs. */
  wixWebhookPublicKey: string;
};

export type Tenant = {
  id: string;
  config: TenantConfig;
  /** Absolute base URL for this tenant, derived per request (e.g. http://host/dev). */
  baseUrl: string;
};

/** Public origin of this service: PUBLIC_BASE_URL, else the (forwarded) request host. */
export function publicOrigin(c: Context): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
  return `${proto}://${host}`;
}

/** Tenant view for a request, or null when the id is unknown. */
export function tenantFor(c: Context, id: string): Tenant | null {
  const config = loadTenantConfig(id);
  return config ? { id, config, baseUrl: `${publicOrigin(c)}/${id}` } : null;
}

const DEFAULTS: TenantConfig = {
  enabled: false,
  merchantName: 'UCP Merchant',
  currency: 'USD',
  simulationSecret: '',
  strictSignatures: false,
  stripeSecretKey: '',
  stripePublishableKey: '',
  stripeApiBase: 'https://api.stripe.com',
  stripeAccountId: '',
  acpWebhookUrl: '',
  acpWebhookSecret: '',
  adapter: 'stub',
  bigcommerceApiBase: 'https://api.bigcommerce.com',
  bigcommerceStoreHash: '',
  bigcommerceAccessToken: '',
  bigcommerceWebhookSecret: '',
  bigcommerceStorefrontUrl: '',
  wixApiBase: 'https://www.wixapis.com',
  wixSiteId: '',
  wixAccessToken: '',
  wixInstanceId: '',
  wixSiteUrl: '',
  wixWebhookPublicKey: '',
};

// -- master key / encryption at rest -----------------------------------------

function masterKey(): Buffer {
  const env = process.env.UCP_MASTER_KEY;
  if (env) return Buffer.from(env, 'hex');
  const file = join(DATA_DIR, 'master.key');
  if (!existsSync(file)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob: string): string {
  const raw = Buffer.from(blob, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// -- tenant load / seed --------------------------------------------------------

/** Credentials stored encrypted (prefix `enc:`); plaintext legacy rows still load. */
const SECRET_FIELDS = ['bigcommerceAccessToken', 'stripeSecretKey', 'wixAccessToken'] as const;
const ENC = 'enc:';

function sealSecrets(config: TenantConfig): TenantConfig {
  const out = { ...config };
  for (const k of SECRET_FIELDS) {
    if (out[k] && !out[k].startsWith(ENC)) out[k] = ENC + encrypt(out[k]);
  }
  return out;
}

function openSecrets(config: TenantConfig): TenantConfig {
  const out = { ...config };
  for (const k of SECRET_FIELDS) {
    if (out[k]?.startsWith(ENC)) out[k] = decrypt(out[k].slice(ENC.length));
  }
  return out;
}

export function loadTenantConfig(id: string): TenantConfig | null {
  const row = getDb().prepare('SELECT config FROM tenants WHERE id = ?').get(id) as
    | { config: string }
    | undefined;
  if (!row) return null;
  return openSecrets({ ...DEFAULTS, ...JSON.parse(row.config) });
}

export function upsertTenant(id: string, config: Partial<TenantConfig>): void {
  const merged = sealSecrets({ ...DEFAULTS, ...(loadTenantConfig(id) ?? {}), ...config });
  getDb()
    .prepare(
      `INSERT INTO tenants (id, config) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET config = excluded.config`,
    )
    .run(id, JSON.stringify(merged));
}

/** Seed tenants from every config/*-tenant.json (idempotent, config wins). */
export function seedTenants(): void {
  const dir = join(ROOT, 'config');
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('-tenant.json')) continue;
    const { id = file.replace(/-tenant\.json$/, ''), ...config } = JSON.parse(
      readFileSync(join(dir, file), 'utf8'),
    );
    upsertTenant(id, config);
  }
}

// -- signing keys ---------------------------------------------------------------

type StoredKey = { privateJwk: string /* encrypted */; publicJwk: Jwk };

function keyRow(id: string): { signing_key: string | null; retired_keys: string } | null {
  return (getDb()
    .prepare('SELECT signing_key, retired_keys FROM tenants WHERE id = ?')
    .get(id) ?? null) as { signing_key: string | null; retired_keys: string } | null;
}

/** Generate + persist an ES256 signing key pair (JWK) on first use. */
async function ensureSigningKey(id: string): Promise<StoredKey> {
  const row = keyRow(id);
  if (!row) throw new Error(`unknown tenant ${id}`);
  if (row.signing_key) return JSON.parse(row.signing_key);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Jwk;
  const publicJwk: Jwk = { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y };
  publicJwk.kid = ecJwkThumbprint(publicJwk);
  const stored: StoredKey = { privateJwk: encrypt(JSON.stringify(privateJwk)), publicJwk };
  getDb().prepare('UPDATE tenants SET signing_key = ? WHERE id = ?').run(JSON.stringify(stored), id);
  return stored;
}

/** The active public signing key as a JWK. */
export async function publicJwk(id: string): Promise<Jwk> {
  return (await ensureSigningKey(id)).publicJwk;
}

/** Active key first, then retired keys still published for rotation grace. */
export async function publishedKeys(id: string): Promise<Jwk[]> {
  const active = await publicJwk(id);
  const row = keyRow(id);
  return [active, ...JSON.parse(row?.retired_keys ?? '[]')];
}

/** The active private signing JWK (decrypted). */
export async function privateJwk(id: string): Promise<Jwk> {
  return JSON.parse(decrypt((await ensureSigningKey(id)).privateJwk));
}

/** Spec rotation: publish a fresh key, keep the old one verifying during grace. */
export async function rotateSigningKey(id: string): Promise<void> {
  const old = await publicJwk(id);
  const row = keyRow(id)!;
  const retired = [old, ...JSON.parse(row.retired_keys)].slice(0, 3);
  getDb()
    .prepare('UPDATE tenants SET signing_key = NULL, retired_keys = ? WHERE id = ?')
    .run(JSON.stringify(retired), id);
  await ensureSigningKey(id);
}

// -- ACP bearer key ----------------------------------------------------------------

/** Bearer key auto-generated on first use; required on every ACP request. */
export function acpApiKey(id: string): string {
  const row = getDb().prepare('SELECT acp_api_key FROM tenants WHERE id = ?').get(id) as
    | { acp_api_key: string | null }
    | undefined;
  if (!row) throw new Error(`unknown tenant ${id}`);
  if (row.acp_api_key) return row.acp_api_key;
  const key = 'acp_' + randomBytes(24).toString('base64url');
  getDb().prepare('UPDATE tenants SET acp_api_key = ? WHERE id = ?').run(key, id);
  return key;
}
