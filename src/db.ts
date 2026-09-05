/**
 * SQLite state: tenants (config + signing keys), checkout sessions,
 * idempotency replay, order entities. All JSON documents, keyed per tenant.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.UCP_DATA_DIR ?? join(ROOT, 'data');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, 'connector.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id           TEXT PRIMARY KEY,
      config       TEXT NOT NULL,           -- TenantConfig JSON
      signing_key  TEXT,                    -- {privateJwk: <encrypted>, publicJwk} JSON
      retired_keys TEXT NOT NULL DEFAULT '[]',
      acp_api_key  TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      tenant     TEXT NOT NULL,
      id         TEXT NOT NULL,
      doc        TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant, id)
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      tenant          TEXT NOT NULL,
      idem_key        TEXT NOT NULL,
      request_hash    TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body   TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      PRIMARY KEY (tenant, idem_key)
    );
    CREATE TABLE IF NOT EXISTS orders (
      tenant       TEXT NOT NULL,
      id           TEXT NOT NULL,
      entity       TEXT NOT NULL,
      platform_ref TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant, id)
    );
  `);
  return db;
}

// -- sessions ---------------------------------------------------------------

export function getSession(tenant: string, id: string): any | null {
  const row = getDb()
    .prepare('SELECT doc FROM sessions WHERE tenant = ? AND id = ?')
    .get(tenant, id) as { doc: string } | undefined;
  return row ? JSON.parse(row.doc) : null;
}

export function saveSession(tenant: string, id: string, doc: any): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (tenant, id, doc, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant, id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
    )
    .run(tenant, id, JSON.stringify(doc), new Date().toISOString());
}

// -- idempotency ------------------------------------------------------------

export type IdempotencyHit = { conflict: true } | { status: number; body: any };

/** Replay identical requests, conflict on same key with a different hash. */
export function idempotencyCheck(
  tenant: string,
  key: string,
  hash: string,
): IdempotencyHit | null {
  const row = getDb()
    .prepare('SELECT request_hash, response_status, response_body FROM idempotency WHERE tenant = ? AND idem_key = ?')
    .get(tenant, key) as
    | { request_hash: string; response_status: number; response_body: string }
    | undefined;
  if (!row) return null;
  if (row.request_hash !== hash) return { conflict: true };
  return { status: row.response_status, body: JSON.parse(row.response_body) };
}

export function idempotencyStore(
  tenant: string,
  key: string,
  hash: string,
  status: number,
  body: any,
): void {
  getDb()
    .prepare(
      `INSERT INTO idempotency (tenant, idem_key, request_hash, response_status, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant, idem_key) DO UPDATE SET
         request_hash = excluded.request_hash, response_status = excluded.response_status,
         response_body = excluded.response_body, created_at = excluded.created_at`,
    )
    .run(tenant, key, hash, status, JSON.stringify(body), new Date().toISOString());
  // ponytail: no purge job — delete rows older than 48h via cron when the table grows.
}

// -- orders -------------------------------------------------------------------

export function getOrder(tenant: string, id: string): any | null {
  const row = getDb()
    .prepare('SELECT entity FROM orders WHERE tenant = ? AND id = ?')
    .get(tenant, id) as { entity: string } | undefined;
  return row ? JSON.parse(row.entity) : null;
}

/** UCP order uuid for a platform order reference (e.g. BigCommerce order id). */
export function orderIdByPlatformRef(tenant: string, ref: string): string | null {
  if (!ref) return null;
  const row = getDb()
    .prepare('SELECT id FROM orders WHERE tenant = ? AND platform_ref = ?')
    .get(tenant, ref) as { id: string } | undefined;
  return row?.id ?? null;
}

export function saveOrder(tenant: string, id: string, entity: any, platformRef = ''): void {
  getDb()
    .prepare(
      `INSERT INTO orders (tenant, id, entity, platform_ref) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant, id) DO UPDATE SET entity = excluded.entity,
         platform_ref = CASE WHEN excluded.platform_ref != '' THEN excluded.platform_ref ELSE orders.platform_ref END`,
    )
    .run(tenant, id, JSON.stringify(entity), platformRef);
}
