# ucp-connector

Multi-tenant UCP/ACP protocol connector in TypeScript — the shared protocol
core for the hosted BigCommerce and Wix adapters (phase 2 of both plans).
Port of the conformance-proven Magento module
(`~/tools/ucp-for-magento`), with platform concerns isolated behind
a `PlatformAdapter` interface.

- **UCP 2026-04-08**: profile discovery, checkout-session state machine
  (`incomplete -> ready_for_complete -> completed/canceled`), idempotency
  replay + 409 conflict, date-based version negotiation (422), discounts,
  fulfillment (destination-aware options, known-customer address injection),
  orders (GET/PUT), signed push webhooks (Webhook-Id/Webhook-Timestamp,
  retry on 5xx/transport error).
- **RFC 9421** HTTP Message Signatures via WebCrypto — ES256/ES384/Ed25519,
  raw P1363, RFC 9530 Content-Digest; inbound verification against the keys in
  the agent profile named by `UCP-Agent`, outbound webhook signing with the
  per-tenant ES256 key.
- **ACP 2026-04-17** dual-protocol layer (port of the Woo shim): same session
  store and state machine, Bearer-key auth, in-band payment declines,
  HMAC-signed order webhooks.
- **Payments**: `mock_payment_handler` (test mode only, gated by the
  simulation secret), `google_pay` and `card_tokenized` via direct Stripe
  PaymentIntent HTTP calls (no Stripe SDK) behind tenant config.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Hono server, tenant-scoped routing (`/{tenant}/ucp/...`, `/{tenant}/.well-known/ucp`, ACP routes, simulate-shipping hook) |
| `src/dispatcher.ts` | UCP pipeline: enablement, version, signature, idempotency, error envelopes |
| `src/checkout.ts` | Session state machine + recalculation (port of Magento `Checkout`) |
| `src/orders.ts` | Order entities, PUT validation, shipping simulation, signed UCP webhooks |
| `src/acp.ts` | ACP translation shim + HMAC webhooks |
| `src/payments.ts` | Handler registry: mock / google_pay / card_tokenized (Stripe direct) |
| `src/rfc9421.ts` | Sign/verify, Content-Digest, JWK handling (WebCrypto) |
| `src/profile.ts` | Business profile, response envelope, platform-profile fetch, SSRF guard |
| `src/adapter.ts` | `PlatformAdapter` interface + `StubAdapter` (fixture data) |
| `src/adapters/bigcommerce.ts` | BigCommerce adapter: Catalog/Customers/Carts/Checkouts V3, Coupons/Orders V2 |
| `src/tenants.ts` | Tenant config, encrypted ES256 signing keys, rotation, ACP bearer key |
| `src/db.ts` | better-sqlite3: tenants, sessions, idempotency, orders |
| `dev/mock-bigcommerce/server.ts` | Mock BigCommerce API (in-memory, seeded from `fixtures.json`) |
| `config/*-tenant.json` | Each file seeds one tenant on boot (`dev` = stub, `bigcommerce-dev` = mock BC) |
| `config/fixtures.json` | Flower-shop-equivalent catalog/discounts/customers/rates (stub + mock BC seed) |
| `config/conformance_input.json`, `config/test_fixtures.json` | Conformance suite configs for the stub adapter |

## Run

```bash
npm install
npm run dev        # tsx watch, http://localhost:8787
npm run start:env  # same as start, loading credentials from .env (copy .env.example)
npm run typecheck  # tsc --noEmit
npm run smoke      # self-contained e2e: boots on an ephemeral port + throwaway DB
```

```bash
curl http://localhost:8787/dev/.well-known/ucp
curl -X POST http://localhost:8787/dev/ucp/checkout-sessions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k1' \
  -d '{"line_items":[{"item":{"id":"bouquet_roses"},"quantity":1}]}'
```

Env: `PORT` (default 8787), `UCP_DATA_DIR` (default `./data`, holds the SQLite
DB and generated master key), `UCP_MASTER_KEY` (32-byte hex; when unset a key
is generated into `data/master.key`). Signing-key private JWKs are AES-256-GCM
encrypted at rest under the master key.

## Conformance

Run the suite (`../conformance`) against a live server:

```bash
npm run start &
cd ../conformance
SERVER_URL=http://localhost:8787/dev \
SIMULATION_SECRET=super-secret-sim-key \
CONFORMANCE_INPUT=../connector/config/conformance_input.json \
FIXTURE_CONFIG=../connector/config/test_fixtures.json \
uv run pytest -q
```

The suite discovers the shopping endpoint from `/{tenant}/.well-known/ucp` and
hits `/{tenant}/testing/simulate-shipping/{id}` relative to `SERVER_URL`, so
the tenant prefix in `SERVER_URL` scopes everything.

## BigCommerce adapter (plan phase 3)

`src/adapters/bigcommerce.ts` maps the `PlatformAdapter` seam onto the
BigCommerce APIs per `../bigcommerce/PLAN.md`: SKU catalog lookup, shipping
rates via a throwaway Carts→Checkouts consignment quote, V2 coupon validation,
customer address lookup, and order creation (cart → billing address →
consignment + shipping option → coupons → `POST /v3/checkouts/{id}/orders`,
which lands `incomplete` → `PUT /v2/orders/{id}` `status_id: 11` marking it
paid with the Stripe charge id). Inbound BigCommerce store webhooks
(`store/shipment/created`, `store/order/statusUpdated`) hit
`POST /{tenant}/bigcommerce/webhooks` (gated by `bigcommerceWebhookSecret` as
an `X-Webhook-Secret` custom header) and are re-emitted as signed UCP order
webhooks.

No real store is wired yet — the `bigcommerce-dev` tenant points at a local
mock of exactly the endpoints the adapter calls:

```bash
npm run mock:bc   # mock BigCommerce API on :8788 (X-Auth-Token: mock-token)
npm run start     # connector on :8787; tenant: /bigcommerce-dev
curl http://localhost:8787/bigcommerce-dev/.well-known/ucp
curl http://localhost:8788/_orders   # debug: V2 order store (status_id 11 = paid)
```

Tenant config keys: `adapter: "bigcommerce"`, `bigcommerceApiBase` (real API:
`https://api.bigcommerce.com`), `bigcommerceStoreHash`,
`bigcommerceAccessToken`, `bigcommerceWebhookSecret`. Conformance against
`/bigcommerce-dev` passes 75/2 skipped, same as the stub.

## BigCommerce app shell (plan phase 5)

`src/bigcommerce-app.ts` turns the connector into a single-click BigCommerce
app. Tenants are created by the OAuth install callback (tenant id = store
hash), no config files involved:

| Route | Role |
|---|---|
| `GET /bigcommerce/auth` | Auth Callback URL: exchanges the code, upserts the tenant, registers the two store webhooks, pushes the profile as a Pages API raw page at `/.well-known/ucp`, renders the settings page |
| `GET /bigcommerce/load` | Load Callback URL: verifies `signed_payload_jwt`, renders the settings page |
| `GET /bigcommerce/uninstall` | Uninstall Callback URL: disables the tenant, drops the token |
| `POST /bigcommerce/settings` | Settings form (enable, strict signatures, Stripe keys, simulation secret); blank keeps a secret, checkbox clears it |

Env: `BC_CLIENT_ID` / `BC_CLIENT_SECRET` (draft app credentials), `BC_LOGIN_BASE`
(default `https://login.bigcommerce.com`), `BC_API_BASE` (default
`https://api.bigcommerce.com`), `PUBLIC_BASE_URL` (public origin used in
profile endpoints, webhook destinations and the OAuth `redirect_uri`; defaults
to the forwarded request host). Store tokens and Stripe secret keys are
encrypted at rest with the master key.

Against the mock (its OAuth endpoint accepts `mock-client-id` /
`mock-client-secret`):

```bash
npm run mock:bc
BC_CLIENT_ID=mock-client-id BC_CLIENT_SECRET=mock-client-secret \
BC_LOGIN_BASE=http://localhost:8788 BC_API_BASE=http://localhost:8788 npm run start
curl "http://localhost:8787/bigcommerce/auth?code=x&scope=store_v2_orders&context=stores/mystore"
curl http://localhost:8788/_storefront/mystore/.well-known/ucp   # the pushed profile page
npm run smoke:install   # 15-step install/load/settings/checkout/uninstall/reinstall check
```

Against a real sandbox: create a draft app in the developer portal with the
three callback URLs above (https), scopes Products/Orders/Carts/Checkouts/
Customers read + Content/Webhooks modify, set the env from the app
credentials, install it from the store's Apps page.

## Adding a platform adapter

Implement `PlatformAdapter` (`src/adapter.ts`): catalog lookup, shipping
options, discount validation, customer addresses, order create. Register it in
`adapterFor()` and set `"adapter"` in the tenant config. The protocol core
never talks to a platform directly.

## Notes

- Official UCP JS SDK: `@ucp-js/sdk@0.4.6` (UCP 2026-04-08, TS types + Zod
  schemas, zod as its only dep) is a dependency; the smoke script validates
  checkout responses against `CheckoutResponseSchema`. Its ESM build has
  broken extensionless imports — fine under tsx/bundlers (CJS build), keep
  that in mind if switching to plain `node` ESM.
- Response signing is not implemented (parity with Magento/Woo, which passed
  conformance without it).

## Wix app shell (plan phase 5)

`src/wix-app.ts` makes the connector a self-managed Wix app. Wix has no OAuth
redirect flow for new apps: tokens are minted per app instance with
client_credentials (4 h, cached in `src/adapters/wix.ts`), installs arrive as
webhooks, and the dashboard page gets an HMAC-signed `instance` parameter.

| Route | Role |
|---|---|
| `POST /wix/webhooks` | The single webhook URL for the app (set in the app dashboard). App Instance Installed creates the tenant (id = instance id) and fills site info; App Instance Removed disables it; eCom order/fulfillment events become signed UCP order webhooks |
| `GET /wix/dashboard?instance=…` | Dashboard page URL: verifies the signed instance, installs on first open if the webhook was missed, shows the `.well-known` setup instructions with a live status check |
| `POST /wix/settings` | Same settings form as BigCommerce |

Env: `WIX_APP_ID` / `WIX_APP_SECRET` (OAuth page of the app dashboard),
`WIX_APP_PUBLIC_KEY` (webhook public key, PEM), `WIX_API_BASE` (default
`https://www.wixapis.com`), `PUBLIC_BASE_URL`.

Webhook subscriptions to add in the app dashboard, all to
`{PUBLIC_BASE_URL}/wix/webhooks`: App Management → App Instance Installed,
App Instance Removed; eCommerce → Order Updated, Order Approved, Fulfillment
Created. Permissions: Stores read, eCom checkout/orders/order transactions
manage, Contacts read, App Instance read.

Against the mock (its OAuth accepts `mock-wix-app-id` / `mock-wix-app-secret`;
webhooks are signed with `dev/mock-wix/webhook-key.pem`):

```bash
npm run mock:wix
WIX_APP_ID=mock-wix-app-id WIX_APP_SECRET=mock-wix-app-secret WIX_API_BASE=http://localhost:8789 \
WIX_APP_PUBLIC_KEY="$(node -e 'const {createPublicKey}=require("node:crypto");process.stdout.write(createPublicKey(require("node:fs").readFileSync("dev/mock-wix/webhook-key.pem")).export({type:"spki",format:"pem"}).toString())')" \
npm run start
curl -X POST localhost:8789/_emit-webhook -H 'content-type: application/json' \
  -d '{"url":"http://localhost:8787/wix/webhooks","eventType":"AppInstalled","instanceId":"site-1"}'
curl http://localhost:8787/site-1/.well-known/ucp
npm run smoke:wix-install   # 13-step install/dashboard/settings/checkout/remove/reinstall check
```

Item ids on Wix sites are Catalog V3 product ids, or `productId:variantId` for a
specific variant; sites still on Catalog V1 are detected (HTTP 428) and served
through the V1 product API.

The merchant-domain `/.well-known/ucp` is not solved by the app: Wix cannot
serve root files, so the dashboard tells the merchant to front the site
(Cloudflare Worker or proxy rule) and reports whether that is live.

## License

Licensed under the [PolyForm Shield License 1.0.0](LICENSE).

In short: you may use, modify and run this connector for any stores you own or operate, for
free, including commercial stores. You may not use it to build, sell or offer a product or
service that competes with it, and any copy you pass on must keep the license and the copyright
notice. See the LICENSE file for the exact terms. Versions before the relicense commit were
published under MIT.
