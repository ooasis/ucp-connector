/**
 * Node entry: SQLite file + config seeds, then serve the shared Hono app.
 * `import('./index.js')` with UCP_NO_LISTEN=1 initialises storage without
 * listening (smoke scripts, seed scripts).
 */

import { serve } from '@hono/node-server';
import { app } from './app.js';
import { readSeedConfigs, useNodeDb } from './db-node.js';
import { seedTenants } from './tenants.js';

useNodeDb();
seedTenants(readSeedConfigs());

export { app };

const port = Number(process.env.PORT ?? 8787);
if (process.env.UCP_NO_LISTEN !== '1') {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`ucp-connector listening on http://localhost:${info.port}`);
    console.log(`dev tenant profile: http://localhost:${info.port}/dev/.well-known/ucp`);
  });
}
