# STATUS — ucp-connector (TS protocol core + BigCommerce + Wix adapters)

*Updated 2026-09-06. Stage 2 (protocol core), stage 3 BigCommerce AND stage 3
Wix (each against a local mock) verified: conformance GREEN on ALL THREE
tenants — 75 passed / 2 skipped each (identical bar to Magento). BigCommerce
AND Wix plan phase 5 (app shells) built and verified against the mocks (below).*

## Wix app shell (plan phase 5, 2026-09-06, uncommitted)

- Wix's current model (custom OAuth is deprecated for new apps): no redirect
  dance. `src/adapters/wix.ts` now mints 4 h access tokens per app instance
  via `POST {WIX_API_BASE}/oauth2/token` (client_credentials with
  `WIX_APP_ID`/`WIX_APP_SECRET` + `instance_id`, cached in-process, refreshed
  a minute early) whenever `wixInstanceId` is set; static `wixAccessToken` +
  `wix-site-id` stay for the dev/legacy tenant. `wix()` is exported.
- `src/wix-app.ts`, mounted at `/wix`: `POST /webhooks` is the ONE app-level
  sink (all subscriptions in the app dashboard point here; Wix has no
  webhook-registration API), verified with `WIX_APP_PUBLIC_KEY`; events are
  routed by `instanceId`: AppInstalled -> `installInstance` (tenant id =
  instanceId, `adapter=wix`, enabled, then `GET /apps/v1/instance` fills
  merchantName/currency/siteId/site url), AppRemoved -> disable (settings
  kept), eCom order/fulfillment -> `handleWixEcomEvent` (shared with the
  per-tenant `/{t}/wix/webhooks` route). `GET /dashboard?instance=` verifies
  Wix's HMAC-SHA256 signed instance (app secret), installs on the spot if the
  install webhook was missed, and renders the settings page with the
  `.well-known` instructions + a live status check (fetches
  `{siteUrl}/.well-known/ucp` through the SSRF guard and compares the
  endpoint). `POST /settings` as BigCommerce.
- `src/app-settings.ts`: settings page, form -> config mapping and the 1 h
  HMAC session token, now shared by both app shells (bigcommerce-app.ts
  refactored onto it; BC smoke still 15/15).
- Mock Wix gained `POST /oauth2/token` (instance tokens `<token>:<instanceId>`,
  no site header needed), `GET /apps/v1/instance`, and `/_emit-webhook` now
  takes `instanceId` and signs AppInstalled/AppRemoved without an order.
- Verified: typecheck clean (scripts included — the two smoke scripts needed
  `as Promise<any>` on fetch JSON); `npm run smoke` green; `npm run
  smoke:install` 15/15; `npm run smoke:wix-install` **13/13** (AppInstalled ->
  tenant + site info, hosted profile, unsigned webhook 403, dashboard ok /
  3 forged 401, settings save + masked + blank-keeps + forged token 401,
  checkout with a client_credentials token, fulfillment webhook via the
  app-level sink -> shipped, AppRemoved 404, reinstall keeps settings,
  unknown instance installed on dashboard open); dev connector restarted
  with BC + Wix env, instance installed via the mock's signed AppInstalled
  webhook, secret set via the form, full conformance vs
  `SERVER_URL=http://localhost:8787/<instanceId>` — **75 passed / 2 skipped**.
- Env: `WIX_APP_ID`, `WIX_APP_SECRET`, `WIX_APP_PUBLIC_KEY`, `WIX_API_BASE`,
  `PUBLIC_BASE_URL`.
- Not done (needs a real dev site + app in the Wix dev center, user action):
  confirm the webhook `eventType` strings for App Instance Installed/Removed
  (the sink matches `AppInstalled|app_instance_installed|app_installed`,
  same for removed — widen if the real slug differs), `GET /apps/v1/instance`
  field names on a live instance, and spike S1 (`.well-known` fronting) which
  the dashboard status row is built to report on. Billing + App Market
  listing per plan.

## BigCommerce app shell (plan phase 5, 2026-09-06, uncommitted)

- `src/bigcommerce-app.ts`, mounted at `/bigcommerce`: `GET /auth` (OAuth
  code -> `POST {BC_LOGIN_BASE}/oauth2/token` -> tenant upsert with id = store
  hash, `adapter=bigcommerce`, `enabled=true`, random webhook secret kept
  across reinstalls; `GET /v2/store` fills merchantName/currency/storefront
  url) then provisions the store: Webhooks V3 registration
  (`store/order/statusUpdated`, `store/shipment/created` ->
  `/{hash}/bigcommerce/webhooks` with the `x-webhook-secret` header,
  idempotent by destination+scope) and the profile pushed as a Pages V3 raw
  page at `/.well-known/ucp` (create-or-update; re-pushed on every settings
  save). `GET /load` / `GET /uninstall` verify BigCommerce's
  `signed_payload_jwt` (HS256 with the client secret, `aud` = client id,
  `exp`); uninstall disables the tenant and drops the token, keeps records.
  `POST /settings` (enable, strict signatures, Stripe keys, simulation secret;
  blank keeps, checkbox clears) is authorized by a 1 h HMAC session token
  minted by auth/load. Provisioning failures are shown on the page, never
  fail the install (the dot-prefixed page path is the known phase-1 risk).
- `tenants.ts`: `publicOrigin(c)` (`PUBLIC_BASE_URL` env, else forwarded
  host) + `tenantFor(c, id)` shared with index.ts; credentials
  (`bigcommerceAccessToken`, `stripeSecretKey`, `wixAccessToken`) now sealed
  at rest with the existing AES-256-GCM master key (`enc:` prefix; plaintext
  legacy rows still load, seeded configs get sealed on boot).
- Mock BC gained `POST /oauth2/token`, `GET /v2/store`, Webhooks V3, Pages V3,
  `/_hooks`, `/_pages`, `/_storefront/{hash}{url}` (serves a pushed page body
  as text/html, like the real storefront).
- Verified: typecheck clean; `npm run smoke` green; `npm run smoke:install`
  **15/15** (install -> encrypted token -> 2 hooks -> page pushed and byte-
  equal to hosted profile -> load ok / 3 bad JWTs 401 -> settings save,
  masked secrets, blank keeps, forged token 401 -> checkout + shipment
  webhook on the new tenant -> uninstall 404s -> reinstall keeps secret, no
  duplicate hooks/pages); dev connector restarted with the app env,
  `smokestore` installed via curl, simulation secret set via the form, full
  conformance vs `SERVER_URL=http://localhost:8787/smokestore` — **75 passed /
  2 skipped**.
- Env: `BC_CLIENT_ID`, `BC_CLIENT_SECRET`, `BC_LOGIN_BASE`, `BC_API_BASE`,
  `PUBLIC_BASE_URL` (see README).
- Not done (needs a real sandbox store + draft app, user action): Pages API
  accepting `url: "/.well-known/ucp"` and the content-type it serves;
  `redirect_uri` must match the draft app's Auth Callback URL exactly;
  BigCommerce requires https webhook destinations. Billing, partner signup
  and marketplace review remain per plan.

## Verify-fix round 1 vs `wix-dev` (2026-09-02)

- Servers already running (connector :8787, mock Wix :8789, mock BC :8788);
  ports 8284/8285 free (no colliding conformance run). Full suite vs
  `SERVER_URL=http://localhost:8787/wix-dev` — **75 passed / 2 skipped /
  0 failed**. No fixes required; no shared code touched. Skips unchanged
  (optional free-shipping SKU, remote ucp.dev schemas). All servers left
  running.

## Wix adapter (DONE against mock — 2026-09-02, wix/PLAN.md phase 3)

- `src/adapters/wix.ts` implements `PlatformAdapter` per the wix/PLAN.md
  mapping table on Cart V2 semantics: catalog via Stores Get Product, coupons
  via Coupons Query (percentOffRate + moneyOffAmount types), known buyers via
  Contacts V4 Query (ISO 3166-2 subdivision "US-IL" -> region "IL"), shipping
  rates via a throwaway checkout + Update Checkout with shippingDestination
  (Wix checkouts can't be deleted; they expire), createOrder = Create Checkout
  (channelType OTHER_PLATFORM) -> Update Checkout (buyer + billing/shipping
  address + first coupon code; Wix holds ONE) -> Update Checkout
  selectedCarrierServiceOption (code match, title fallback, then cheapest) ->
  Create Order From Checkout -> Order Transactions **Add Payments** recording
  the external Stripe charge (dedupe on providerTransactionId) -> poll
  paymentStatus until PAID (~1s cap; charge is authoritative regardless).
  Registered in `src/adapter.ts` as adapter `wix`.
- Inbound Wix webhooks: `POST /{tenant}/wix/webhooks` — body is a raw RS256
  JWT signed with the app key (real-Wix format: claims.data and event.data are
  nested JSON strings), verified via `verifyWixWebhookJwt` against
  `wixWebhookPublicKey` in tenant config (403 otherwise);
  `*fulfillment_created` -> order_shipped, `order_updated|order_approved` ->
  order_updated, both re-emitted as signed UCP webhooks + ACP order_update.
  Order resolved via data.orderId ?? entityId against orders.platform_ref.
  Webhook registration on install is plan phase 5.
- Mock Wix API: `dev/mock-wix/server.ts` (`npm run mock:wix`, port 8789, auth
  Authorization `mock-wix-token` + `wix-site-id: mock-site`), in-memory,
  seeded from `config/fixtures.json` (same flower shop), covering exactly the
  endpoints the adapter calls. Realism modeled: Wix error envelopes
  (`details.applicationError`), Add Payments failing the WHOLE call on a
  duplicate providerTransactionId, paymentStatus recalculating async (~250ms
  PENDING -> PAID, which exercises the adapter's poll), create-order rejecting
  a checkout without destination or selectedCarrierServiceOption. Debug:
  `GET /_orders`; `POST /_emit-webhook {url, eventType, orderId}` signs a
  Wix-style webhook JWT with `dev/mock-wix/webhook-key.pem` (matching public
  key in the tenant config) and delivers it — used to simulate Wix deliveries.
- `config/wix-dev-tenant.json` seeds the `wix-dev` tenant
  (adapter=wix, wixApiBase=http://localhost:8789).
- Verified 2026-09-02: typecheck clean; `npm run smoke` all green (stub);
  curl e2e on wix-dev (create 7000 + live carrier options from mock ->
  std-ship + 10OFF -> ready_for_complete 6750 -> complete with mock token ->
  Wix order PAID total 67.50 with the payment recorded -> contacts-based
  address injection for john.doe@example.com -> `/_emit-webhook`
  fulfillment_created -> UCP order shows `shipped` event; garbage JWT -> 403);
  full conformance vs `SERVER_URL=http://localhost:8787/wix-dev` — **75
  passed / 2 skipped / 0 failed** (same skips as ever).
- **Gotcha: conformance runs COLLIDE across agents.** The suite hardcodes its
  mock webhook/agent-profile servers on ports 8284/8285 (absl flag defaults,
  no env override). A concurrent run (e.g. the PrestaShop agent, whose agent
  profile points webhooks at host.docker.internal) that wins the bind makes
  this run's webhook tests fail with "no order-event webhook delivered" (+ an
  ap2 ReadTimeout from webhook retry stalls). First wix-dev run failed 10
  tests exactly this way; after waiting for the other pytest to exit, 75/2
  clean. Check `lsof -iTCP:8285 -sTCP:LISTEN` before blaming the adapter.
- **Wix spikes S1/S2 are USER ACTIONS** (no real Wix site available to
  agents): S1 `.well-known/ucp` placement on a live Wix domain (the
  make-or-break; likely Cloudflare Worker fronting), S2 real Cart V2 parity —
  the mock encodes the documented shapes, so verify against a sandbox site:
  real product GUIDs as catalogItemId (fixture ids stand in for them here),
  carrierServiceOptions population, coupon query filter shape, Add Payments
  response, and the real webhook eventType slugs (mock uses
  `wix.ecom.v1.fulfillment_created` / `order_updated` / `order_approved`;
  the route matches by substring, but confirm). Phase 5 (OAuth install,
  per-site config, webhook registration) not started.

## Verify-fix round 3 vs `bigcommerce-dev` (2026-09-02)

- Fresh restart of both servers (`npm run mock:bc` then `npm run start` in
  `connector/`, logs in `data/mock-bc.out` / `data/connector.out`); full
  conformance suite vs `SERVER_URL=http://localhost:8787/bigcommerce-dev` —
  **75 passed / 2 skipped / 0 failed**. No fixes required; skips unchanged
  (optional free-shipping SKU, remote ucp.dev schemas). Both servers left
  running.

## Verify-fix round 2 vs `bigcommerce-dev` (2026-09-02)

- Fresh restart of both servers; typecheck clean, smoke 14/14; curl e2e on
  bigcommerce-dev re-verified (create -> destination select -> std-ship +
  10OFF -> ready_for_complete 6750 -> complete -> BC order status_id 11 total
  67.50 -> shipment webhook -> `shipped` event on the order; 403 on bad
  webhook secret); conformance vs `/bigcommerce-dev` — **75 passed / 2
  skipped / 0 failed**.
- **One fix**: mock BC restarted its order counter at 101 while
  `data/connector.db` persists, so `orders.platform_ref` collided with stale
  rows and the inbound shipment webhook resolved to yesterday's order.
  `dev/mock-bigcommerce/server.ts` now seeds `orderSeq` from the clock
  (real BC ids are store-unique forever); connector code untouched.

## Verify-fix round 1 vs stub `dev` tenant (2026-09-02)

- Connector already running on :8787 (left from prior session); full
  conformance suite vs `SERVER_URL=http://localhost:8787/dev` — **75 passed /
  2 skipped / 0 failed**. No fixes required. Same invocation as the
  "Conformance" section below; skips unchanged (optional free-shipping SKU,
  remote ucp.dev schemas).

## Re-verification 2026-09-02 (protocol-core stage)

- Found `src/adapters/wix.ts` half-done from a prior session (NOT wired into
  the `src/adapter.ts` registry, but breaking typecheck). Added the three
  missing `TenantConfig` fields it expects (`wixApiBase`/`wixSiteId`/
  `wixAccessToken`, defaults mirroring the bigcommerce block) — typecheck
  clean again. wix.ts itself untouched. (Registry wiring, `wix-dev` tenant,
  and verification done later on 2026-09-02 — see the Wix adapter section.)
- `npm run typecheck` clean; `npm run smoke` 14/14 green.
- Curl-verified live on :8787 stub `dev` tenant: profile 200, create 201
  (subtotal 7000, options under `methods[0].groups[0].options`), option
  select + 10OFF -> ready_for_complete total 6750, complete with mock
  `success_token` -> completed + order id, order GET 200, UCP-Agent
  `version="2099-01-01"` -> 422 VERSION_UNSUPPORTED, unknown tenant 404,
  ACP discovery 200. Note: version negotiation reads the `UCP-Agent` header's
  `version=` param, NOT a `UCP-Version` header.
- Both dev servers restarted with current code and left running:
  connector :8787 (`npm run start`) and mock BigCommerce :8788
  (`npm run mock:bc`), logs in `data/connector.out` / `data/mock-bc.out`.

## Done

- Node 20+/TypeScript/Hono/better-sqlite3 connector at `connector/`, ported
  from the Magento module (protocol behavior) and the Woo ACP shim.
- Multi-tenant routing (`/{tenant}/ucp/...`, `/{tenant}/.well-known/ucp`,
  `/{tenant}/.well-known/acp.json`, `/{tenant}/acp/checkout_sessions...`,
  `/{tenant}/testing/simulate-shipping/{id}`); tenants table; `dev` tenant
  seeded from `config/dev-tenant.json` on boot.
- RFC 9421 sign + verify via WebCrypto (ES256/ES384/Ed25519, raw P1363,
  RFC 9530 Content-Digest); per-tenant ES256 keys generated on first use,
  private JWK AES-256-GCM-encrypted at rest (master key: `UCP_MASTER_KEY` env
  or auto-generated `data/master.key`); rotation keeps retired keys published.
- Full dispatcher pipeline: version negotiation (422), signature-if-present
  (strict mode per tenant), idempotency replay + 409, UCP error envelopes.
- Checkout state machine, discounts (sequential on subtotal+fulfillment),
  fulfillment merge/normalization, known-customer address injection,
  destination-aware shipping options, order entities + PUT validation,
  simulate-shipping hook, signed UCP push webhooks with retry, SSRF guard.
- ACP layer at Woo parity (2026-04-17): Bearer key (auto-generated per
  tenant), api-version check, idempotency, session translation, in-band
  payment declines, order_create/order_update HMAC webhooks.
- Payments: mock handler (test mode only), google_pay + card_tokenized via
  Stripe PaymentIntent direct API behind tenant config (`stripeSecretKey`,
  `stripeApiBase` overridable for stripe-mock).
- `PlatformAdapter` interface + `StubAdapter` driven by `config/fixtures.json`
  (flower-shop-equivalent data matching `config/conformance_input.json` +
  `config/test_fixtures.json`).
- Official UCP JS SDK `@ucp-js/sdk@0.4.6` (types + zod, UCP 2026-04-08) wired
  in; smoke validates responses against `CheckoutResponseSchema`.
- Verified: `npm run typecheck` clean; `npm run smoke` — 14/14 steps green
  (profile, version 422, create/update/complete/cancel, idempotency
  replay+conflict, discounts math, address injection, out-of-stock, RFC 9421
  signed-request round trip incl. tamper rejection, mock decline, order GET,
  simulate-shipping + both signed webhooks, ACP full flow). Also curl-verified
  live on :8787 (create -> option+discount -> complete -> order GET, ACP
  discovery, unknown tenant 404).

## BigCommerce adapter (DONE against mock — 2026-09-01, plan phase 3)

- `src/adapters/bigcommerce.ts` implements `PlatformAdapter` per the
  bigcommerce/PLAN.md mapping table: SKU lookup (Catalog V3), shipping rates
  via throwaway cart + consignment quote
  (`?include=consignments.available_shipping_options`), coupon validation
  (V2 Coupons; percentage + per_total types), customer addresses
  (Customers V3), createOrder = cart -> billing address -> consignment +
  shipping option (id match, title fallback, then cheapest) -> coupons ->
  `POST /v3/checkouts/{id}/orders` (incomplete) -> `PUT /v2/orders/{id}`
  status_id 11 + `payment_provider_id` = Stripe charge id.
- `PlatformAdapter.shippingOptions` now takes `CartLine[]` (id + quantity)
  instead of `string[]` ids — BigCommerce (and any real platform) needs
  quantities for a correct cart-total quote (free-shipping threshold). Stub
  updated; both tenants re-passed conformance after the change.
- Inbound BC store webhooks: `POST /{tenant}/bigcommerce/webhooks`
  (X-Webhook-Secret gated, timing-safe): `store/shipment/created` ->
  order_shipped, `store/order/statusUpdated` -> order_updated, both re-emitted
  as signed UCP webhooks + ACP order_update. Platform order id resolved via
  `orderIdByPlatformRef` (orders.platform_ref). Always 2xx so BC keeps the
  hook alive; webhook registration itself is plan phase 5 (OAuth install).
- Mock BigCommerce API: `dev/mock-bigcommerce/server.ts` (`npm run mock:bc`,
  port 8788, X-Auth-Token `mock-token`), in-memory, seeded from
  `config/fixtures.json` (same flower shop), covering exactly the endpoints
  the adapter calls + `GET /_orders` debug dump. V2 quirks modeled: 204 on
  empty coupon lookups, bare (non-enveloped) V2 bodies.
- Tenant seeding generalized: every `config/*-tenant.json` seeds on boot
  (`seedTenants`); added `config/bigcommerce-dev-tenant.json`
  (adapter=bigcommerce, apiBase=http://localhost:8788).
- Verified: typecheck clean; `npm run smoke` 14/14 (stub); curl e2e on
  bigcommerce-dev (create with buyer -> injected BC customer addresses ->
  option select -> 10OFF -> complete with mock token -> BC order status_id 11,
  totals match 108.00 -> shipment webhook -> shipped event + 403 on bad
  secret); conformance 75/2 on BOTH `/dev` and `/bigcommerce-dev`.
- Verify-fix round 1 (2026-09-01): fresh restart of connector (8787) + mock BC
  (8788), full suite vs `/bigcommerce-dev` — 75 passed / 2 skipped / 0 failed.
  No fixes required. Start: `npm run mock:bc` then `npm run start` (both in
  `connector/`), then the pytest invocation below with
  `SERVER_URL=http://localhost:8787/bigcommerce-dev`.

## Conformance (protocol core, stage 2 — DONE 2026-09-01)

Full suite run against the stub-adapter `dev` tenant: **75 passed, 2 skipped,
0 failed** — no code changes needed. Skips (same as Magento's run):
- `fulfillment_test.py:675` — no `free_shipping_item_sku` in fixtures (optional).
- `protocol_test.py:101` — schemas not yet published on remote ucp.dev.

Exact invocation (note: configs are passed via env vars, NOT pytest flags —
the README's `--conformance_input=` form is rejected by pytest):

```bash
cd connector && npm run start &   # serves http://localhost:8787
cd conformance
SERVER_URL=http://localhost:8787/dev \
SIMULATION_SECRET=super-secret-sim-key \
CONFORMANCE_INPUT=../connector/config/conformance_input.json \
FIXTURE_CONFIG=../connector/config/test_fixtures.json \
uv run pytest -q
```

## Remaining

- **BigCommerce phase 1 spike is a USER ACTION** (no sandbox store/API token
  available to agents): create a sandbox store, test Pages API with
  `url: "/.well-known/ucp"` for profile placement, then point a real tenant at
  it (`bigcommerceApiBase: https://api.bigcommerce.com`, real store hash +
  token) and re-run conformance. Adapter assumes simple products
  (product-level SKUs); variant SKUs need a `/v3/catalog/variants` lookup.
- BigCommerce phases 4–5 leftovers: webhook registration on install, OAuth
  app shell, Pages API profile publisher, Stripe key onboarding UI.
- Wix spikes S1/S2 (user actions, see Wix adapter section) + phase 5 app shell.

## Notes / gotchas for the next agent

- `@ucp-js/sdk` ESM build is broken (extensionless imports) — works via tsx
  (CJS). Don't switch scripts to bare `node --experimental-strip-types`.
- Smoke uses a throwaway `UCP_DATA_DIR`; the dev server writes `data/` (gitignored).
- Port 8787 chosen as free on this machine; magento-env uses 8180/8190; the
  BigCommerce mock uses 8788 (matches `bigcommerceApiBase` in
  `config/bigcommerce-dev-tenant.json`); the Wix mock uses 8789 (matches
  `wixApiBase` in `config/wix-dev-tenant.json`). A stale connector may be left
  listening on 8787 from a prior session — smoke on another port via `PORT=`.
- No git commits made — working tree only, per instructions.
