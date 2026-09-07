/**
 * Node runtime pieces: the better-sqlite3 database file, the auto-generated
 * master key file, and the config/*-tenant.json seed files. Never imported by
 * the Cloudflare Worker build (worker.ts).
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, setDefaultDb, type SqlDb } from './db.js';
import { setMasterKeyFallback } from './tenants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.UCP_DATA_DIR ?? join(ROOT, 'data');

/** Open data/connector.db, run the schema, and make it the process-wide database. */
export function useNodeDb(): SqlDb {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(join(DATA_DIR, 'connector.db'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  setDefaultDb(db);
  setMasterKeyFallback(nodeMasterKey);
  return db;
}

/** Master key from data/master.key, generated on first use (when UCP_MASTER_KEY is unset). */
function nodeMasterKey(): Buffer {
  const file = join(DATA_DIR, 'master.key');
  if (!existsSync(file)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

/** Parsed config/*-tenant.json files (id defaults to the file name). */
export function readSeedConfigs(): Record<string, any>[] {
  const dir = join(ROOT, 'config');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('-tenant.json'))
    .map((f) => ({ id: f.replace(/-tenant\.json$/, ''), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}
