/**
 * MONTCOXPLR — Cloudflare Worker CORS relay
 * ---------------------------------------------------------------------
 * Montgomery County, PA serves several of the dashboard's data sources as
 * plain HTML/RSS (and some open-data GeoJSON) with no CORS headers, which
 * a static GitHub Pages site can't read directly from the browser:
 *
 *   /rss              -> livecadrss.asp
 *   /oos              -> livecad-unitsoos.asp
 *   /incidents        -> livecad-incidents.asp  (list + eid/num for unit lookup)
 *   /units            -> livecad-incidents.asp?units=1&eid=&num=  (assigned units)
 *   /overlay/power    -> power-outages.geojson
 *   /overlay/road     -> road-conditions.geojson
 *   /overlay/winter   -> winter-conditions.geojson
 *   /overlay/events   -> planned-events.geojson
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

const OVERLAY_UPSTREAM = {
  power: 'https://gis.montcopa.org/opendata/data/power-outages.geojson',
  road: 'https://gis.montcopa.org/opendata/data/road-conditions.geojson',
  winter: 'https://gis.montcopa.org/opendata/data/winter-conditions.geojson',
  events: 'https://gis.montcopa.org/opendata/data/planned-events.geojson'
};

const CACHE_SECONDS = {
  rss: 60,
  oos: 60,
  incidents: 60,
  units: 30,
  overlay: 90
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, ''); // '' | 'rss' | 'overlay/power' | ...

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (path === '' || path === 'health') {
      return json(
        {
          ok: true,
          routes: [
            '/rss',
            '/oos',
            '/incidents',
            '/units',
            '/overlay/power',
            '/overlay/road',
            '/overlay/winter',
            '/overlay/events'
          ]
        },
        200,
        env
      );
    }

    // Overlay routes: /overlay/power | /overlay/road | ...
    if (path.startsWith('overlay/')) {
      const key = path.slice('overlay/'.length);
      const upstreamUrl = OVERLAY_UPSTREAM[key];
      if (!upstreamUrl) {
        return json(
          { error: 'Unknown overlay. Use /overlay/power|road|winter|events.' },
          404,
          env
        );
      }
      return proxyUpstream(upstreamUrl, 'application/geo+json; charset=utf-8', CACHE_SECONDS.overlay, env, ctx, url);
    }

    if (!UPSTREAM[path]) {
      return json(
        { error: 'Unknown route. Use /rss, /oos, /incidents, /units, or /overlay/*.' },
        404,
        env
      );
    }

    let upstreamUrl = UPSTREAM[path];
    if (path === 'units') {
      const eid = url.searchParams.get('eid') || '';
      const num = url.searchParams.get('num') || '';
      if (!eid || !num) {
        return json({ error: 'units requires eid and num query params' }, 400, env);
      }
      upstreamUrl =
        `${UPSTREAM.units}?units=1&eid=${encodeURIComponent(eid)}&num=${encodeURIComponent(num)}`;
    }

    const contentType =
      path === 'rss' ? 'application/rss+xml; charset=utf-8' : 'text/html; charset=utf-8';
    const cacheTtl = CACHE_SECONDS[path] ?? 60;
    return proxyUpstream(upstreamUrl, contentType, cacheTtl, env, ctx, url);
  }
};

async function proxyUpstream(upstreamUrl, contentType, cacheTtl, env, ctx, requestUrl) {
  const cache = caches.default;
  const cacheKey = new Request(requestUrl.toString(), { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(cached, env);
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      cf: { cacheTtl, cacheEverything: true },
      headers: {
        'User-Agent': 'MontcoXplrDashboard/1.0 (+https://github.com/jasonsaro-ops/montcoxplr)',
        Accept: 'application/json, application/geo+json, text/html, application/rss+xml, */*'
      }
    });
  } catch (err) {
    return json({ error: 'Upstream fetch failed', detail: String(err) }, 502, env);
  }

  if (!upstreamResponse.ok) {
    return json({ error: `Upstream returned HTTP ${upstreamResponse.status}` }, 502, env);
  }

  let body = await upstreamResponse.text();
  // Strip UTF-8 BOM that some IIS JSON endpoints emit
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);

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
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(env)
    }
  });
}
