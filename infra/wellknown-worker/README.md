# ucp-wellknown-worker

Serves a merchant's UCP business profile at `https://<merchant-domain>/.well-known/ucp`
when the storefront platform cannot host root files (Wix). Agents discover the
merchant on the storefront domain; the Worker answers that one path from the
connector's hosted profile and touches nothing else.

```
agent ──GET /.well-known/ucp──> Cloudflare (merchant domain) ──Worker──> connector /<tenant>/.well-known/ucp
       ──everything else────────> Cloudflare ─────────────────────────────> Wix origin (unchanged)
```

The Worker is routed only to `/.well-known/ucp`, so other storefront traffic
never runs through it. Responses are cached for 60 s.

## Prerequisites (merchant)

1. A custom domain for the Wix site whose DNS is on Cloudflare. Connect the
   domain to Wix by **pointing** (A/CNAME records Wix gives you), not by
   moving nameservers to Wix.
2. Those Wix DNS records **proxied** (orange cloud) in Cloudflare, SSL/TLS mode
   **Full**. Proxying is what lets a Worker route intercept the path. Confirm
   the storefront still loads after enabling the proxy before adding the Worker.
3. A Cloudflare account with Workers enabled (free plan is enough).

A free `*.wixsite.com` address cannot be fronted: there is no DNS to control.

## Deploy (one Worker per merchant domain)

```sh
cd infra/wellknown-worker
npm install
npx wrangler login
```

Edit `wrangler.jsonc`:

- `name`: e.g. `ucp-wellknown-flowershop`
- `routes[0].pattern`: `shop.example.com/.well-known/ucp`, `zone_name`: `example.com`
- `vars.UCP_PROFILE_URL`: the tenant's hosted profile, shown on the app's
  dashboard page as "Hosted profile" (`https://<connector>/<tenantId>/.well-known/ucp`)

```sh
npx wrangler deploy
curl https://shop.example.com/.well-known/ucp   # must return the profile JSON directly (no redirect)
```

Reopen the app's dashboard page in Wix: the "Storefront profile" row checks
the URL and reports `ok` when the served profile points at this tenant's
endpoint.

## Local check

With the connector running on `localhost:8787`:

```sh
npx wrangler dev --port 8790 --var "UCP_PROFILE_URL:http://localhost:8787/<tenantId>/.well-known/ucp"
curl http://localhost:8790/.well-known/ucp
```

Only the profile path is meaningful locally; other paths would be proxied to
the dev server itself.

## Notes

- Conformance and agents do not follow redirects, so a 301 to the connector is
  not an alternative; the body must be served on the merchant origin.
- The Worker adds `access-control-allow-origin: *` and `cache-control: public, max-age=60`.
- Key rotation on the connector propagates within the 60 s cache window.
- Multi-merchant variant (single Worker, host -> tenant map in KV) is a small
  follow-up when per-merchant deployments become tedious.
