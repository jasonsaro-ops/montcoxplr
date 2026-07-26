/* =========================================================================
   MONTCOXPLR — LIVE INCIDENT MONITOR
   -------------------------------------------------------------------------
   Data reality check (read this before deploying):

   INCIDENTS (Fire / EMS / Traffic) come exclusively from Montgomery
   County's ArcGIS hosted feature layer — the same data powering the
   county's own ArcGIS Experience app at
   https://experience.arcgis.com/experience/028de5f59b014757bda5cc2444d1f0c9
   and mobile dashboard at
   https://www.arcgis.com/apps/dashboards/28de0ecb1fb14a76b9b84c042d274c59.
   This is the ONLY source with coordinates, and it's the single source of
   truth here — nothing else is blended in, so counts always match the
   county's own map exactly.

   ⚠ STALENESS GOTCHA: the two "hub.arcgis.com/.../downloads/data" and
   the "opendata.arcgis.com/.../downloads/data" URLs below are Esri's Hub
   *download/export* API. That's a periodically-regenerated static
   snapshot, NOT a live query against the feature layer — if that
   snapshot job stalls, the data can silently freeze at whatever it last
   generated (this is what caused old dates to show up). The real fix is
   to query the hosted FeatureServer directly, which is always live:

   IF THE MAP FEED SHOWS STALE OR "DOWN" DATA: open the Experience app
   link above, open your browser's DevTools → Network tab, filter for
   "FeatureServer" or "query", reload the page, and copy the request URL
   whose path contains "FeatureServer" — paste it as the FIRST entry in
   CONFIG.sources.arcgisCandidates below (add
   "&outFields=*&f=geojson" if the copied URL doesn't already return
   GeoJSON). Once a live FeatureServer URL is in place, remove or ignore
   the two Hub download URLs — they're just a snapshot-based fallback.

   UNITS OUT OF SERVICE (separate panel, not part of incident counts)
   comes from a plain HTML page (livecad-unitsoos.asp) with no CORS
   headers, so it's fetched through the Cloudflare Worker relay (see
   DEPLOY.md) and parsed generically from whatever <table> rows it
   returns.
   ========================================================================= */

const CONFIG = {
  refreshIntervalMs: 60000,   // county CAD data itself only updates every 4-5 min
  clockUpdateMs: 1000,
  demoAfterFailedSources: true, // show clearly-labeled demo data if everything fails

  map: {
    center: [40.1400, -75.3200], // Montgomery County, PA centroid
    zoom: 11,
    minZoom: 9,
    maxZoom: 18,
    // Correct CARTO raster path is "dark_all" (not "dark_matter") with
    // explicit a/b/c/d subdomains — the previous build 404'd on every
    // tile because of that path typo, which is why the map looked blank.
    tileUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    tileSubdomains: 'abcd',
    tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    // Fallback basemap in case CARTO is ever unreachable from a given network
    fallbackTileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    fallbackTileSubdomains: 'abc',
    fallbackTileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  },

  sources: {
    // Your Cloudflare Worker relay. Set this once it's deployed — see
    // DEPLOY.md. Format: https://<worker-name>.<your-subdomain>.workers.dev
    // (no trailing slash). Leave as '' to skip straight to the public
    // CORS-proxy fallbacks below.
    worker: {
      baseUrl: 'https://montcoxplr.jasonsaro.workers.dev'
    },

    // Tried in order; first one that returns usable geometry wins.
    // #1 is the confirmed LIVE FeatureServer query (real-time, not a
    // snapshot) — found via DevTools on the county's Experience app. Its
    // "type" field carries clean values: 'Fire' | 'EMS' | 'Traffic'.
    // #2 and #3 are Esri's Hub "downloads/data" snapshot/export API —
    // kept only as a last-resort fallback since that export can lag the
    // live map by hours or days if the regeneration job stalls.
    arcgisCandidates: [
      'https://services1.arcgis.com/kOChldNuKsox8qZD/arcgis/rest/services/Montgomery_County_911_Incidents/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson',
      'https://hub.arcgis.com/api/v3/datasets/b438c9b5aa684ccc87c6f0058d3ff6f6_0/downloads/data?format=geojson&spatialRefId=4326',
      'https://opendata.arcgis.com/api/v3/datasets/b438c9b5aa684ccc87c6f0058d3ff6f6_0/downloads/data?format=geojson&spatialRefId=4326',
      'https://data-montcopa.opendata.arcgis.com/datasets/montcopa::montgomery-county-911-incidents.geojson'
    ],

    oos: {
      url: 'https://webapp07.montcopa.org/eoc/cadinfo/livecad-unitsoos.asp',
      corsProxies: [
        (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`
      ]
    }
  }
};

// Category keyword → class map. Montco CAD "content"/type text looks like
// "FIRE SPECIAL SERVICE", "EMS - MEDICAL", "VEHICLE ACCIDENT", etc. This
// scans whatever text fields exist rather than depending on one field name.
const CATEGORY_RULES = [
  { cat: 'fire',    test: /\bfire\b|\bfd\b|smoke|structure\s*fire|brush\s*fire|explosion/i },
  { cat: 'traffic', test: /traffic|\bmva\b|vehicle accident|collision|crash|road|highway|disabled veh/i },
  { cat: 'ems',     test: /\bems\b|medical|ambulance|rescue|cardiac|respiratory|fall victim|overdose|injury/i }
];

const COLORS = {
  fire: '#ff4438',
  ems: '#2f8fff',
  traffic: '#f5c142',
  other: '#9c7cf0'
};

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
const state = {
  incidents: [],       // normalized incident objects currently displayed
  markers: new Map(),  // id -> Leaflet marker
  activeFilter: 'all',
  selectedId: null,
  sourceStatus: { arcgis: 'connecting', oos: 'connecting' },
  isDemo: false,
  map: null,
  oosUnits: []
};

// ---------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initClock();
  initFilters();
  initResetView();
  refreshAll();
  refreshOos();
  setInterval(refreshAll, CONFIG.refreshIntervalMs);
  setInterval(refreshOos, CONFIG.refreshIntervalMs);
});

// ---------------------------------------------------------------------
// RESET VIEW
// ---------------------------------------------------------------------
function initResetView() {
  const btn = document.getElementById('reset-view-btn');
  if (!btn) return;
  btn.addEventListener('click', resetMapView);
}

function resetMapView() {
  state.selectedId = null;
  document.querySelectorAll('.incident-card').forEach((c) => c.classList.remove('selected'));
  state.map.closePopup();
  state.map.flyTo(CONFIG.map.center, CONFIG.map.zoom, { animate: true, duration: 0.8 });
}

// ---------------------------------------------------------------------
// MAP
// ---------------------------------------------------------------------
function initMap() {
  const m = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView(CONFIG.map.center, CONFIG.map.zoom);

  const primaryTiles = L.tileLayer(CONFIG.map.tileUrl, {
    subdomains: CONFIG.map.tileSubdomains,
    minZoom: CONFIG.map.minZoom,
    maxZoom: CONFIG.map.maxZoom,
    attribution: CONFIG.map.tileAttribution
  });

  // If the primary basemap ever fails to load tiles (network block, CDN
  // outage), swap to the OSM fallback automatically rather than leaving
  // the map blank.
  let fallenBack = false;
  primaryTiles.on('tileerror', () => {
    if (fallenBack) return;
    fallenBack = true;
    m.removeLayer(primaryTiles);
    L.tileLayer(CONFIG.map.fallbackTileUrl, {
      subdomains: CONFIG.map.fallbackTileSubdomains,
      minZoom: CONFIG.map.minZoom,
      maxZoom: CONFIG.map.maxZoom,
      attribution: CONFIG.map.fallbackTileAttribution
    }).addTo(m);
  });

  primaryTiles.addTo(m);
  state.map = m;
}

function makeDivIcon(cat) {
  const color = COLORS[cat] || COLORS.other;
  return L.divIcon({
    className: '',
    html: `<div class="pulse-marker">
             <div class="ring" style="background:${color}"></div>
             <div class="core" style="background:${color}"></div>
           </div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8]
  });
}

function renderMarkers() {
  // clear stale markers
  state.markers.forEach((marker) => state.map.removeLayer(marker));
  state.markers.clear();

  const visible = state.incidents.filter(
    (i) => i.lat != null && i.lon != null &&
           (state.activeFilter === 'all' || i.cat === state.activeFilter)
  );

  visible.forEach((inc) => {
    const marker = L.marker([inc.lat, inc.lon], { icon: makeDivIcon(inc.cat) });
    marker.bindPopup(`
      <div class="popup-inner">
        <div class="p-type" style="color:${COLORS[inc.cat] || COLORS.other}">${escapeHtml(inc.type)}</div>
        <div class="p-row">${escapeHtml(inc.address)}</div>
        <div class="p-row">${escapeHtml(inc.municipality || '')}</div>
        <div class="p-row">Station: ${escapeHtml(inc.station || '—')}</div>
        <div class="p-row">Dispatched: ${escapeHtml(inc.dispatched || '—')}</div>
      </div>
    `);
    marker.on('click', () => selectIncident(inc.id));
    marker.addTo(state.map);
    state.markers.set(inc.id, marker);
  });

  document.getElementById('badge-count').textContent = visible.length;
  document.getElementById('badge-time').textContent = new Date().toLocaleTimeString();
}

// ---------------------------------------------------------------------
// DATA FETCHING — ArcGIS (primary, has coordinates)
// ---------------------------------------------------------------------
async function fetchArcgis() {
  for (const url of CONFIG.sources.arcgisCandidates) {
    try {
      const bustedUrl = url + (url.includes('?') ? '&' : '?') + '_ts=' + Date.now();
      const res = await fetch(bustedUrl, { cache: 'no-store' });
      if (!res.ok) continue;
      const json = await res.json();
      const features = json.features || [];
      if (!Array.isArray(features) || features.length === 0) continue;

      const incidents = features.map((f, idx) => normalizeArcgisFeature(f, idx)).filter(Boolean);
      if (incidents.length > 0) {
        setSourceStatus('arcgis', 'live');
        return incidents;
      }
    } catch (err) {
      // try next candidate
      continue;
    }
  }
  setSourceStatus('arcgis', 'down');
  return null;
}

function normalizeArcgisFeature(feature, idx) {
  const props = feature.properties || {};
  const geom = feature.geometry;
  if (!geom) return null;

  let lon, lat;
  if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
    [lon, lat] = geom.coordinates;
  } else {
    return null;
  }

  const displayType = firstDefined(props, [
    'content', 'Content', 'category', 'Category', 'cad_type', 'CallType',
    'call_type', 'type', 'Type', 'incident_type', 'CAD_TYPE', 'nature'
  ]) || 'INCIDENT';

  // The county's own categorical field — confirmed values are exactly
  // 'Fire' | 'EMS' | 'Traffic'. Trust this over keyword-guessing whenever
  // it's present; only fall back to the text heuristic if it's missing or
  // holds something unexpected.
  const rawCategory = firstDefined(props, ['type', 'Type']);

  const address = firstDefined(props, [
    'address', 'Address', 'location', 'Location', 'full_address', 'street'
  ]) || 'Address unavailable';

  const municipality = firstDefined(props, [
    'municipality', 'Municipality', 'city', 'City', 'twp', 'township'
  ]) || '';

  const station = firstDefined(props, [
    'station', 'Station', 'unit', 'Unit', 'responding_station'
  ]) || '';

  const dispatched = firstDefined(props, [
    'dispatched', 'Dispatched', 'dispatch_time', 'DispatchTime', 'date', 'Date', 'time_dispatched'
  ]) || '';

  const description = firstDefined(props, [
    'description', 'Description', 'descr', 'remarks', 'Remarks', 'details'
  ]) || '';

  return {
    id: `ag-${props.OBJECTID || props.objectid || props.FID || idx}`,
    type: String(displayType).toUpperCase(),
    address,
    municipality,
    station,
    dispatched: formatMaybeDate(dispatched),
    description,
    cat: classifyIncident(rawCategory, `${displayType} ${description}`),
    lat, lon,
    source: 'arcgis',
    _sortKey: toSortKey(dispatched)
  };
}

// Builds the ordered list of URLs to try for a given feed ('oos'):
// the Worker relay first (if configured), then each public CORS proxy
// wrapping the direct county URL.
function buildCandidateUrls(kind) {
  const urls = [];
  const workerBase = CONFIG.sources.worker.baseUrl;
  if (workerBase) urls.push(`${workerBase.replace(/\/+$/, '')}/${kind}`);

  const src = CONFIG.sources[kind];
  src.corsProxies.forEach((buildProxyUrl) => urls.push(buildProxyUrl(src.url)));
  return urls;
}

// ---------------------------------------------------------------------
// DATA FETCHING — Units Out of Service (OOS)
// ---------------------------------------------------------------------
async function refreshOos() {
  setSourceStatus('oos', 'connecting');
  const units = await fetchOos();
  state.oosUnits = units || [];
  renderOosList();
}

async function fetchOos() {
  for (const url of buildCandidateUrls('oos')) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const html = await res.text();
      const units = parseOosHtml(html);
      setSourceStatus('oos', 'live');
      return units; // note: an empty array is a valid "zero units OOS" result
    } catch (err) {
      continue;
    }
  }
  setSourceStatus('oos', 'down');
  return null;
}

// The county serves this as a plain HTML page rather than a documented
// feed, so this parses generically off whatever <table> rows come back
// instead of assuming exact column names — it degrades gracefully if the
// county changes the page's markup rather than throwing.
function parseOosHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = Array.from(doc.querySelectorAll('table tr'));
    const units = [];

    rows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td'))
        .map((c) => c.textContent.replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0);

      if (cells.length === 0) return;
      // skip obvious header rows (e.g. "Unit", "Station", "Reason")
      if (cells.length <= 2 && /unit|station|reason|status|out of service/i.test(cells.join(' '))) return;

      units.push({
        unit: cells[0] || 'UNIT',
        detail: cells.slice(1).join(' · ')
      });
    });

    return units;
  } catch (err) {
    return [];
  }
}

function renderOosList() {
  const list = document.getElementById('oos-list');
  if (!list) return;

  if (state.sourceStatus.oos === 'down') {
    list.innerHTML = `<div class="oos-empty">OOS FEED UNAVAILABLE</div>`;
    return;
  }
  if (!state.oosUnits || state.oosUnits.length === 0) {
    list.innerHTML = `<div class="oos-empty">NO UNITS OUT OF SERVICE</div>`;
    return;
  }

  list.innerHTML = state.oosUnits.slice(0, 40).map((u) => `
    <div class="oos-item">
      <div class="oos-unit">${escapeHtml(u.unit)}</div>
      ${u.detail ? `<div class="oos-detail">${escapeHtml(u.detail)}</div>` : ''}
    </div>
  `).join('');
}

// ---------------------------------------------------------------------
// REFRESH ORCHESTRATION
// ---------------------------------------------------------------------
async function refreshAll() {
  setSourceStatus('arcgis', 'connecting');
  setRefreshCountdown();

  const arcgisIncidents = await fetchArcgis();

  let combined = [];
  if (arcgisIncidents && arcgisIncidents.length) {
    combined = arcgisIncidents;
  }

  if (combined.length === 0 && CONFIG.demoAfterFailedSources) {
    combined = getDemoIncidents();
    state.isDemo = true;
  } else {
    state.isDemo = false;
  }

  if (combined.length === 0 && CONFIG.demoAfterFailedSources) {
    combined = getDemoIncidents();
    state.isDemo = true;
  } else {
    state.isDemo = false;
  }

  // newest first
  combined.sort((a, b) => (b._sortKey || 0) - (a._sortKey || 0));

  state.incidents = combined;
  document.getElementById('demo-banner').classList.toggle('show', state.isDemo);

  renderMarkers();
  renderStats();
  renderFeedList();
  renderTicker();
}

// ---------------------------------------------------------------------
// RENDER: stats / feed list / ticker
// ---------------------------------------------------------------------
function renderStats() {
  const counts = { fire: 0, ems: 0, traffic: 0, other: 0 };
  state.incidents.forEach((i) => { counts[i.cat] = (counts[i.cat] || 0) + 1; });
  document.getElementById('stat-all').textContent = state.incidents.length;
  document.getElementById('stat-fire').textContent = counts.fire;
  document.getElementById('stat-ems').textContent = counts.ems;
  document.getElementById('stat-traffic').textContent = counts.traffic;
}

function renderFeedList() {
  const list = document.getElementById('feed-list');
  const filtered = state.incidents.filter(
    (i) => state.activeFilter === 'all' || i.cat === state.activeFilter
  );

  if (filtered.length === 0) {
    list.innerHTML = `<div class="feed-empty">NO ${state.activeFilter === 'all' ? '' : state.activeFilter.toUpperCase() + ' '}INCIDENTS ACTIVE</div>`;
    return;
  }

  list.innerHTML = filtered.slice(0, 80).map((i) => `
    <div class="incident-card ${i.id === state.selectedId ? 'selected' : ''}" data-cat="${i.cat}" data-id="${i.id}">
      <div class="top-row">
        <div class="type">${escapeHtml(i.type)}</div>
        <div class="time">${escapeHtml(relativeTime(i._sortKey))}</div>
      </div>
      <div class="loc">${escapeHtml(i.address)}${i.municipality ? ' · ' + escapeHtml(i.municipality) : ''}</div>
      ${i.description ? `<div class="desc">${escapeHtml(i.description)}</div>` : ''}
      <div class="meta">
        ${i.station ? `<span>STA ${escapeHtml(i.station)}</span>` : ''}
        ${i.dispatched ? `<span>${escapeHtml(i.dispatched)}</span>` : ''}
        <span class="${i.lat != null ? 'geo-yes' : 'geo-no'}">${i.lat != null ? 'MAPPED' : 'NO GEO'}</span>
        <span>${i.source.toUpperCase()}</span>
      </div>
      ${i.lat != null ? `<div class="zoom-hint">⌖ Click to zoom on map</div>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('.incident-card').forEach((card) => {
    card.addEventListener('click', () => selectIncident(card.dataset.id));
  });
}

function selectIncident(id) {
  const inc = state.incidents.find((i) => i.id === id);
  if (!inc) return;

  state.selectedId = id;
  document.querySelectorAll('.incident-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.id === id);
  });

  if (inc.lat != null && inc.lon != null) {
    state.map.flyTo([inc.lat, inc.lon], Math.max(state.map.getZoom(), 15), { animate: true, duration: 0.6 });
    const marker = state.markers.get(inc.id);
    if (marker) {
      // popup can only open once the flyTo settles on some browsers
      setTimeout(() => marker.openPopup(), 350);
    }
  }
}

function renderTicker() {
  const el = document.getElementById('ticker-content');
  if (state.incidents.length === 0) {
    el.innerHTML = '<span>No active incidents reported.</span>';
    el.style.animationDuration = '40s';
    return;
  }
  const items = state.incidents.slice(0, 25);
  el.innerHTML = items.map((i) => {
    const cls = i.cat === 'fire' ? 'tk-fire' : i.cat === 'ems' ? 'tk-ems' : i.cat === 'traffic' ? 'tk-traffic' : '';
    return `<span class="${cls}">● ${escapeHtml(i.type)} — ${escapeHtml(i.address)}${i.municipality ? ', ' + escapeHtml(i.municipality) : ''}</span>`;
  }).join('');

  // Slow, unhurried pace: roughly 9s of scroll per item, floor of 90s so
  // it never feels rushed even with just one or two incidents.
  const duration = Math.max(90, items.length * 9);
  el.style.animationDuration = `${duration}s`;
}

// ---------------------------------------------------------------------
// FILTERS
// ---------------------------------------------------------------------
function initFilters() {
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeFilter = btn.dataset.filter;
      renderMarkers();
      renderFeedList();
    });
  });

  document.querySelectorAll('.stat-card').forEach((card) => {
    card.addEventListener('click', () => {
      const cat = card.dataset.cat;
      document.querySelectorAll('.stat-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      const matchingFilterBtn = document.querySelector(`.filter-btn[data-filter="${cat}"]`);
      if (matchingFilterBtn) matchingFilterBtn.click();
    });
  });
}

// ---------------------------------------------------------------------
// CLOCK + STATUS CHIPS
// ---------------------------------------------------------------------
function initClock() {
  tickClock();
  setInterval(tickClock, CONFIG.clockUpdateMs);
}

function tickClock() {
  const now = new Date();
  document.getElementById('clock-local').textContent = now.toLocaleTimeString('en-US', { hour12: false });
  document.getElementById('clock-date').textContent = now.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}

let nextSyncAt = 0;
function setRefreshCountdown() {
  nextSyncAt = Date.now() + CONFIG.refreshIntervalMs;
}
setInterval(() => {
  const secsLeft = Math.max(0, Math.round((nextSyncAt - Date.now()) / 1000));
  const el = document.getElementById('lbl-refresh');
  if (el) el.textContent = `NEXT SYNC ${secsLeft}S`;
  const dot = document.getElementById('dot-refresh');
  if (dot) dot.className = 'dot live';
}, 1000);

const SOURCE_LABELS = {
  arcgis: 'CAD MAP FEED'
};

function setSourceStatus(source, status) {
  state.sourceStatus[source] = status;
  const dot = document.getElementById(`dot-${source}`);
  dot && (dot.className = 'dot ' + (status === 'live' ? 'live' : status === 'connecting' ? 'degraded' : 'down'));

  const lbl = document.getElementById(`lbl-${source}`);
  if (lbl && SOURCE_LABELS[source]) {
    const statusText = status === 'live' ? 'LIVE' : status === 'connecting' ? 'SYNCING' : 'OFFLINE';
    lbl.textContent = `${SOURCE_LABELS[source]} · ${statusText}`;
  }
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
// Prefers the county's own exact category field ('Fire' | 'EMS' | 'Traffic')
// over keyword-guessing. Falls back to the fuzzy text heuristic only when
// that field is missing or holds something unrecognized (e.g. a source
// with a different schema, like the Hub snapshot fallbacks).
function classifyIncident(rawCategory, fallbackText) {
  if (rawCategory) {
    const norm = String(rawCategory).trim().toLowerCase();
    if (norm === 'fire') return 'fire';
    if (norm === 'ems') return 'ems';
    if (norm === 'traffic') return 'traffic';
  }
  return classify(fallbackText);
}

function classify(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(text)) return rule.cat;
  }
  return 'other';
}

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
  }
  return null;
}

function toSortKey(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function relativeTime(ms) {
  if (!ms) return '';
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 0) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function formatMaybeDate(value) {
  if (!value) return '';
  // ArcGIS often returns epoch millis for date fields
  if (typeof value === 'number') {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toLocaleString('en-US', { hour12: false });
  }
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toLocaleString('en-US', { hour12: false });
  return String(value);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------------------------------------------------------------------
// DEMO DATA — only ever shown when both live sources fail, with a banner
// ---------------------------------------------------------------------
function getDemoIncidents() {
  const base = CONFIG.map.center;
  const now = Date.now();
  const sample = [
    { type: 'FIRE SPECIAL SERVICE', address: 'Ridge Pike & Butler Pike', municipality: 'Plymouth Twp', station: 'STA28', mins: 4, dLat: 0.02, dLon: 0.01 },
    { type: 'EMS - MEDICAL', address: '400 Fayette St', municipality: 'Conshohocken', station: 'STA30', mins: 9, dLat: -0.015, dLon: 0.02 },
    { type: 'VEHICLE ACCIDENT', address: 'US-202 & DeKalb Pike', municipality: 'Whitpain Twp', station: '—', mins: 14, dLat: 0.03, dLon: -0.03 },
    { type: 'STRUCTURE FIRE', address: 'Germantown Pike', municipality: 'East Norriton', station: 'STA26', mins: 22, dLat: -0.03, dLon: -0.015 },
    { type: 'EMS - FALL VICTIM', address: 'W Main St', municipality: 'Norristown', station: 'STA1', mins: 27, dLat: 0.008, dLon: -0.025 },
    { type: 'TRAFFIC HAZARD', address: 'PA-476 NB', municipality: 'Plymouth Twp', station: '—', mins: 33, dLat: 0.018, dLon: 0.03 }
  ];
  return sample.map((s, idx) => ({
    id: `demo-${idx}`,
    type: s.type,
    address: s.address,
    municipality: s.municipality,
    station: s.station,
    dispatched: new Date(now - s.mins * 60000).toLocaleString('en-US', { hour12: false }),
    description: '',
    cat: classify(s.type),
    lat: base[0] + s.dLat,
    lon: base[1] + s.dLon,
    source: 'demo',
    _sortKey: now - s.mins * 60000
  }));
}
