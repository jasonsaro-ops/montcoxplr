/**
 * MONTCOXPLR — Cloudflare Worker CORS relay
 * ---------------------------------------------------------------------
 * Montgomery County, PA serves several of the dashboard's data sources as
 * plain HTML/RSS with no CORS headers, which a static GitHub Pages site
 * can't read directly from the browser:
 *
 *   /rss       -> livecadrss.asp
 *   /oos       -> livecad-unitsoos.asp
 *   /incidents -> livecad-incidents.asp  (list + eid/num for unit lookup)
 *   /units     -> livecad-incidents.asp?units=1&eid=&num=  (assigned units)
 *
 * This Worker fetches those on the dashboard's behalf, adds an
 * Access-Control-Allow-Origin header, and caches each response at the
 * edge for CACHE_SECONDS (units use a shorter TTL so status stays fresh).
 *
 * Deploy: see /DEPLOY.md in the repo root. Once deployed, this Worker's
 * URL goes into CONFIG.sources.worker.baseUrl in app.js.
 */

const UPSTREAM = {
  rss: 'https://webapp07.montcopa.org/eoc/cadinfo/livecadrss.asp',
  oos: 'https://webapp07.montcopa.org/eoc/cadinfo/livecad-unitsoos.asp',
  incidents: 'https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp',
  units: 'https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp'
};

const CACHE_SECONDS = {
  rss: 60,
  oos: 60,
  incidents: 60,
  units: 30
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/+|\/+$/g, ''); // '' | 'rss' | 'oos' | ...

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (route === '' || route === 'health') {
      return json({ ok: true, routes: ['/rss', '/oos', '/incidents', '/units'] }, 200, env);
    }

    if (!UPSTREAM[route]) {
      return json({ error: 'Unknown route. Use /rss, /oos, /incidents, or /units.' }, 404, env);
    }

    let upstreamUrl = UPSTREAM[route];
    if (route === 'units') {
      const eid = url.searchParams.get('eid') || '';
      const num = url.searchParams.get('num') || '';
      if (!eid || !num) {
        return json({ error: 'units requires eid and num query params' }, 400, env);
      }
      upstreamUrl =
        `${UPSTREAM.units}?units=1&eid=${encodeURIComponent(eid)}&num=${encodeURIComponent(num)}`;
    }

    const cacheTtl = CACHE_SECONDS[route] ?? 60;
    const cache = caches.default;
    // Units include eid/num in the Worker URL so each incident caches separately.
    const cacheKey = new Request(url.toString(), { method: 'GET' });

    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCors(cached, env);
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        cf: { cacheTtl, cacheEverything: true },
        headers: {
          'User-Agent': 'MontcoXplrDashboard/1.0 (+https://github.com/jasonsaro-ops/montcoxplr)'
        }
      });
    } catch (err) {
      return json({ error: 'Upstream fetch failed', detail: String(err) }, 502, env);
    }

    if (!upstreamResponse.ok) {
      return json({ error: `Upstream returned HTTP ${upstreamResponse.status}` }, 502, env);
    }

    const body = await upstreamResponse.text();
    const contentType = route === 'rss'
      ? 'application/rss+xml; charset=utf-8'
      : 'text/html; charset=utf-8';

    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${cacheTtl}`
      }
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return withCors(response, env);
  }
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOWED_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function withCors(response, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}
