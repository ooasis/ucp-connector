/**
 * Serves the merchant's UCP business profile at https://<merchant-domain>/.well-known/ucp
 * for platforms that cannot host root files (Wix). Cloudflare proxies the
 * merchant domain; this Worker is routed only to the profile path and answers
 * it from the connector's hosted profile. Everything else passes to the origin.
 */

export interface Env {
  UCP_PROFILE_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/.well-known/ucp') return fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    let upstream: Response;
    try {
      upstream = await fetch(env.UCP_PROFILE_URL, {
        headers: { accept: 'application/json' },
        cf: { cacheEverything: true, cacheTtl: 60 },
      });
    } catch {
      return Response.json({ error: 'profile upstream unreachable' }, { status: 502 });
    }
    if (!upstream.ok) {
      return Response.json({ error: 'profile unavailable' }, { status: upstream.status === 404 ? 404 : 502 });
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60',
        'access-control-allow-origin': '*',
      },
    });
  },
} satisfies ExportedHandler<Env>;
