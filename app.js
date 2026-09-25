/* =========================================================================
   MONTCOXPLR — LIVE INCIDENT MONITOR
   -------------------------------------------------------------------------
   Data reality check (read this before deploying):

   INCIDENTS prefer the county's live CAD FeatureServer that powers the
   official Active Incidents Map View:
     https://www.montgomerycountypa.gov/departments/department-public-safety/webcad-active-incidents/active-incidents-map-view
     → embeds https://gis.montcopa.org/opendata/incidents-map.html
     → queries Hosted/Montgomery_County_Active_CAD_Incidents_View

   That layer is the primary source with coordinates. Older services1 /
   Hub snapshot URLs are kept only as fallbacks.

   ⚠ STALENESS + RSS FAILOVER: If every geometry source is down or the
   newest incident is older than CONFIG.staleMaxAgeMs, we fall through to
   the live WebCAD RSS feed (livecadrss.asp). RSS has no coordinates —
   list/stats/ticker still work; map markers stay empty and cards show
   "NO GEO".

   Nature of call (FIRE ALARM, CARDIAC EMERGENCY, VEHICLE ACCIDENT, …)
   comes from `incidenttype` (not the coarse `type` field which is only
   Fire|EMS|Traffic) and from the RSS title/description.

   UNITS ASSIGNED TO AN INCIDENT come from livecad-incidents.asp (the
   county's WebCAD Active Incidents page). The list HTML maps each
   incident number → internal eid; expanding a call requests
   ?units=1&eid=&num= and returns a small unit/status/time table.
   Clicking an incident expands that card in the live feed column to
   show assigned units (click again to collapse) and zooms the map.

   UNITS OUT OF SERVICE (separate panel) still comes from
   livecad-unitsoos.asp via the Cloudflare Worker / CORS proxies.
   ========================================================================= */

const CONFIG = {
  refreshIntervalMs: 60000,   // county CAD data itself only updates every 4-5 min
  clockUpdateMs: 1000,
  demoAfterFailedSources: true, // show clearly-labeled demo data if everything fails
  // Fire / EMS / Traffic newer than this stay pinned at the top of the
  // live feed column, newest first. After the window they fall into the
  // normal category-priority list below.
  feedPinMs: 5 * 60 * 1000, // 5 minutes
  // Re-sort the feed (without refetching) so pinned items drop on time.
  feedResortMs: 30 * 1000,
  // If the newest ArcGIS incident is older than this, treat the feed as
  // frozen and fall through to the live RSS CAD feed.
  staleMaxAgeMs: 45 * 60 * 1000, // 45 minutes

  map: {
    center: [40.1400, -75.3200], // Montgomery County, PA centroid
    zoom: 11,
    minZoom: 9,
    maxZoom: 18,
    // OpenStreetMap raster tiles (full zoom 0–19, no API key).
    // Dark theme is applied via CSS filter on .leaflet-tile-pane in
    // index.html — invert + hue-rotate keeps the map dark at every zoom
    // without depending on a provider that limits max zoom or requires a key.
    // (CARTO watermarks without a key; Esri Dark Gray stops around z16.)
    tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileSubdomains: 'abc',
    tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    // Fallback mirror if the primary OSM CDN is blocked/unreachable
    fallbackTileUrl: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
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

    // Tried in order; first one that returns usable *fresh* geometry wins.
    // #1 — NEW live FeatureServer behind the county's Active Incidents
    //      Map View (gis.montcopa.org). Same schema: type = Fire|EMS|Traffic,
    //      incidenttype = actual nature, location/mun/station/dispatched.
    // #2 — Legacy services1 FeatureServer (often frozen / retired).
    // #3–#5 — Esri Hub snapshot exports — last-resort only.
    arcgisCandidates: [
      'https://gis.montcopa.org/arcgis/rest/services/Hosted/Montgomery_County_Active_CAD_Incidents_View/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson',
      'https://services1.arcgis.com/kOChldNuKsox8qZD/arcgis/rest/services/Montgomery_County_911_Incidents/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson',
      'https://hub.arcgis.com/api/v3/datasets/b438c9b5aa684ccc87c6f0058d3ff6f6_0/downloads/data?format=geojson&spatialRefId=4326',
      'https://opendata.arcgis.com/api/v3/datasets/b438c9b5aa684ccc87c6f0058d3ff6f6_0/downloads/data?format=geojson&spatialRefId=4326',
      'https://data-montcopa.opendata.arcgis.com/datasets/montcopa::montgomery-county-911-incidents.geojson'
    ],

    // Live WebCAD RSS — used when ArcGIS is down OR stale. Same data as
    // https://www.montgomerycountypa.gov/departments/department-public-safety/webcad-active-incidents
    // No coordinates; list/stats/ticker only.
    rss: {
      url: 'https://webapp07.montcopa.org/eoc/cadinfo/livecadrss.asp',
      corsProxies: [
        (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`
      ]
    },

    // WebCAD incident list (HTML) — provides eid↔incidentno mapping used
    // to fetch assigned units for the detail panel.
    incidents: {
      url: 'https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp',
      corsProxies: [
        (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`
      ]
    },

    // Assigned units for one incident. Worker builds the query string;
    // public CORS proxies append ?units=1&eid=&num= to the base URL.
    units: {
      url: 'https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp',
      corsProxies: [
        (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`
      ]
    },

    oos: {
      url: 'https://webapp07.montcopa.org/eoc/cadinfo/livecad-unitsoos.asp',
      corsProxies: [
        (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`
      ]
    },

    // County open-data overlays (same feeds as the WebCAD side pages).
    overlays: {
      powerOutages: 'https://gis.montcopa.org/opendata/data/power-outages.geojson',
      roadConditions: 'https://gis.montcopa.org/opendata/data/road-conditions.geojson',
      winterConditions: 'https://gis.montcopa.org/opendata/data/winter-conditions.geojson',
      plannedEvents: 'https://gis.montcopa.org/opendata/data/planned-events.geojson'
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
  outage: '#ff6b00',
  road511: '#c44dff',
  winter: '#7ec8ff',
  planned: '#ff4d9a',
  other: '#9c7cf0'
};

// County-style outage severity fills (None / Minor / Moderate / Major / Severe)
const OUTAGE_SEVERITY_COLORS = {
  none: '#c5cdd6',
  minor: '#f7e08a',
  moderate: '#f0b429',
  major: '#e67e22',
  severe: '#c0392b'
};

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
const state = {
  incidents: [],       // normalized incident objects currently displayed
  markers: new Map(),  // id -> Leaflet marker
  activeFilter: 'all',       // category: all | fire | ems | traffic
  unitStatusFilter: 'all',   // unit status: all | enroute | arrived | dispatched | other
  selectedId: null,
  sourceStatus: { arcgis: 'connecting', rss: 'connecting', oos: 'connecting' },
  activeIncidentSource: null, // 'arcgis' | 'rss' | 'demo' | null
  isDemo: false,
  map: null,
  oosUnits: [],
  audioEnabled: false,
  knownIncidentIds: new Set(), // ids seen as of the last non-demo refresh
  hasBaseline: false,          // true once we've established a starting set to diff against
  // incident number (e.g. E2671198) → { eid, num } from WebCAD list HTML
  incidentEidByNum: new Map(),
  // incident number → { units: [...], fetchedAt, status: 'loading'|'ok'|'empty'|'error' }
  unitsCache: new Map(),
  // Feed card currently expanded to show assigned units (toggle on click)
  expandedId: null,
  // Leaflet layer group for polygon/line overlays (outages, winter roads)
  overlayLayer: null
};

// ---------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initClock();
  initFilters();
  initResetView();
  initAudioToggle();
  initCrestRefresh();
  refreshAll();
  refreshOos();
  setInterval(refreshAll, CONFIG.refreshIntervalMs);
  setInterval(refreshOos, CONFIG.refreshIntervalMs);
  setInterval(resortFeedList, CONFIG.feedResortMs || 30000);
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
// AUDIO ALERTS
// Synthesized with the Web Audio API (no audio files to host) — three
// distinct chimes so Fire, EMS, and Traffic are recognizable by ear
// without looking at the screen.
// ---------------------------------------------------------------------
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Schedules a single tone: quick fade in, hold, fade out (avoids the
// clicking pop a hard on/off would cause).
function scheduleTone(freq, startTime, duration, waveType, peakGain) {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = waveType;
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

// FIRE — urgent alternating two-tone wail (sawtooth, higher edge)
function playFireTone() {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  [880, 660, 880, 660].forEach((freq, i) => {
    scheduleTone(freq, now + i * 0.15, 0.14, 'sawtooth', 0.2);
  });
}

// EMS — calm rising two-note chime (sine, gentle)
function playEmsTone() {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  scheduleTone(523.25, now, 0.32, 'sine', 0.2);       // C5
  scheduleTone(784.0, now + 0.28, 0.4, 'sine', 0.2);   // G5
}

// TRAFFIC — short flat double-beep (triangle, neutral)
function playTrafficTone() {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  scheduleTone(440, now, 0.1, 'triangle', 0.2);
  scheduleTone(440, now + 0.17, 0.1, 'triangle', 0.2);
}

// Soft refresh ping — short rising blip (used by the crest radar click)
function playRefreshTone() {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  scheduleTone(660, now, 0.08, 'sine', 0.12);
  scheduleTone(990, now + 0.09, 0.12, 'sine', 0.1);
}

const CATEGORY_TONES = { fire: playFireTone, ems: playEmsTone, traffic: playTrafficTone };

// Plays one chime per category that has a new arrival, staggered so
// simultaneous fire+EMS+traffic dispatches don't blur into noise.
function playAlertsForCategories(categorySet) {
  let delay = 0;
  ['fire', 'ems', 'traffic'].forEach((cat) => {
    if (!categorySet.has(cat)) return;
    setTimeout(() => CATEGORY_TONES[cat](), delay);
    delay += 850;
  });
}

// Compares this refresh's incident IDs against the last known set. The
// very first real (non-demo) load just establishes the baseline —
// otherwise every incident already active when you open the page would
// trigger an alert.
function detectAndAlertNewIncidents(incidents) {
  const currentIds = new Set(incidents.map((i) => i.id));

  if (state.hasBaseline) {
    const newCats = new Set();
    incidents.forEach((i) => {
      if (!state.knownIncidentIds.has(i.id)) newCats.add(i.cat);
    });
    if (newCats.size > 0 && state.audioEnabled) {
      playAlertsForCategories(newCats);
    }
  } else {
    state.hasBaseline = true;
  }

  state.knownIncidentIds = currentIds;
}

function initAudioToggle() {
  const btn = document.getElementById('audio-toggle-btn');
  if (!btn) return;

  let stored = null;
  try { stored = localStorage.getItem('montcoxplr_audio_enabled'); } catch (err) { /* ignore */ }
  state.audioEnabled = stored === 'true';
  updateAudioToggleUI();

  btn.addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    try { localStorage.setItem('montcoxplr_audio_enabled', String(state.audioEnabled)); } catch (err) { /* ignore */ }

    if (state.audioEnabled) {
      // This click is the required user gesture to unlock audio — use it
      // to both resume the context and give an audible confirmation.
      getAudioCtx();
      playTrafficTone();
    }
    updateAudioToggleUI();
  });
}

function updateAudioToggleUI() {
  const btn = document.getElementById('audio-toggle-btn');
  const lbl = document.getElementById('lbl-audio');
  if (!btn || !lbl) return;
  btn.classList.toggle('on', state.audioEnabled);
  lbl.textContent = state.audioEnabled ? 'ALERT TONES ON' : 'ALERT TONES OFF';
}

// ---------------------------------------------------------------------
// MAP
// ---------------------------------------------------------------------
function initMap() {
  const m = L.map('map', {
    zoomControl: false,
    attributionControl: true
  }).setView(CONFIG.map.center, CONFIG.map.zoom);

  // Default zoom control sits top-left, right over the map badge and any
  // incident pins in that corner. Moved to top-right, stacked under the
  // Reset View button instead (see .leaflet-top.leaflet-right CSS).
  L.control.zoom({ position: 'topright' }).addTo(m);

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
  state.overlayLayer = L.layerGroup().addTo(m);
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
  if (state.overlayLayer) state.overlayLayer.clearLayers();

  const visible = state.incidents.filter(
    (i) => i.lat != null && i.lon != null &&
           (state.activeFilter === 'all' || i.cat === state.activeFilter)
  );

  visible.forEach((inc) => {
    // Polygon / line overlays (power outages, winter road segments)
    if (inc.geometry && state.overlayLayer) {
      try {
        const style = overlayStyleFor(inc);
        const layer = L.geoJSON(inc.geometry, { style: () => style });
        layer.on('click', () => selectIncident(inc.id));
        layer.bindPopup(buildPopupHtml(inc));
        layer.addTo(state.overlayLayer);
      } catch (err) { /* ignore bad geometry */ }
    }

    // Point / centroid markers (always — outage polygons also get a pin)
    const marker = L.marker([inc.lat, inc.lon], { icon: makeDivIcon(inc.cat) });
    marker.bindPopup(buildPopupHtml(inc));
    marker.on('click', () => selectIncident(inc.id));
    marker.addTo(state.map);
    state.markers.set(inc.id, marker);
  });

  document.getElementById('badge-count').textContent = visible.length;
  document.getElementById('badge-time').textContent = new Date().toLocaleTimeString();
}

function buildPopupHtml(inc) {
  const color = COLORS[inc.cat] || COLORS.other;
  return `
    <div class="popup-inner">
      <div class="p-type" style="color:${color}">${escapeHtml(inc.type)}</div>
      ${inc.incidentno ? `<div class="p-row">${escapeHtml(inc.incidentno)}</div>` : ''}
      <div class="p-row">${escapeHtml(inc.address || '')}</div>
      <div class="p-row">${escapeHtml(inc.municipality || '')}</div>
      ${inc.station ? `<div class="p-row">Station: ${escapeHtml(inc.station)}</div>` : ''}
      ${inc.description ? `<div class="p-row">${escapeHtml(inc.description)}</div>` : ''}
      ${inc.dispatched ? `<div class="p-row">${escapeHtml(inc.dispatched)}</div>` : ''}
    </div>
  `;
}

function overlayStyleFor(inc) {
  if (inc.cat === 'outage') {
    const fill = OUTAGE_SEVERITY_COLORS[inc.severity] || OUTAGE_SEVERITY_COLORS.moderate;
    return {
      color: '#ff6b00',
      weight: 1.5,
      fillColor: fill,
      fillOpacity: 0.45,
      opacity: 0.9
    };
  }
  if (inc.cat === 'winter') {
    const isClear = /clear/i.test(inc.severity || inc.type || '');
    return {
      color: isClear ? '#7ec8ff' : '#3d9be9',
      weight: isClear ? 2 : 4,
      opacity: isClear ? 0.35 : 0.85
    };
  }
  return { color: COLORS[inc.cat] || COLORS.other, weight: 2, fillOpacity: 0.3 };
}

function outageSeverity(percentOut, customersOut) {
  const pct = Number(percentOut) || 0;
  const n = Number(customersOut) || 0;
  if (n <= 0 && pct <= 0) return 'none';
  if (pct < 0.5 && n < 50) return 'minor';
  if (pct < 2 || n < 200) return 'moderate';
  if (pct < 10 || n < 1000) return 'major';
  return 'severe';
}

function centroidOfGeometry(geom) {
  if (!geom) return null;
  const pts = [];
  const walk = (c) => {
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      pts.push(c);
      return;
    }
    if (Array.isArray(c)) c.forEach(walk);
  };
  walk(geom.coordinates);
  if (!pts.length) return null;
  let sx = 0, sy = 0;
  pts.forEach(([x, y]) => { sx += x; sy += y; });
  return { lon: sx / pts.length, lat: sy / pts.length };
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
      if (incidents.length === 0) continue;

      // Reject silently-frozen snapshots (yesterday's data while CAD is live).
      if (isIncidentSetStale(incidents)) {
        console.warn('[montcoxplr] ArcGIS data is stale — falling through to RSS');
        setSourceStatus('arcgis', 'down');
        return null;
      }

      setSourceStatus('arcgis', 'live');
      setSourceStatus('rss', 'down'); // not needed when ArcGIS is good
      return incidents;
    } catch (err) {
      continue;
    }
  }
  setSourceStatus('arcgis', 'down');
  return null;
}

function isIncidentSetStale(incidents) {
  if (!incidents || incidents.length === 0) return true;
  let newest = 0;
  for (const i of incidents) {
    if (i._sortKey && i._sortKey > newest) newest = i._sortKey;
  }
  if (!newest) return true;
  return (Date.now() - newest) > CONFIG.staleMaxAgeMs;
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

  // Coarse category field is exactly 'Fire' | 'EMS' | 'Traffic'.
  const rawCategory = firstDefined(props, ['type', 'Type']);

  // Actual call nature lives in incidenttype (e.g. CARDIAC EMERGENCY,
  // FIRE ALARM, VEHICLE ACCIDENT). Prefer that over the coarse type.
  const nature = firstDefined(props, [
    'incidenttype', 'IncidentType', 'incident_type',
    'content', 'Content', 'nature', 'Nature',
    'cad_type', 'CallType', 'call_type'
  ]);
  // If nature is missing or is just the coarse category, fall back.
  let displayType = nature;
  if (!displayType || /^(fire|ems|traffic)$/i.test(String(displayType).trim())) {
    displayType = firstDefined(props, [
      'content', 'Content', 'category', 'Category',
      'incidenttype', 'IncidentType'
    ]) || rawCategory || 'INCIDENT';
  }

  const address = firstDefined(props, [
    'address', 'Address', 'location', 'Location', 'full_address', 'street'
  ]) || 'Address unavailable';

  const municipality = firstDefined(props, [
    'mun', 'Mun', 'municipality', 'Municipality', 'city', 'City', 'twp', 'township'
  ]) || '';

  const station = firstDefined(props, [
    'station', 'Station', 'unit', 'Unit', 'responding_station'
  ]) || '';

  const dispatched = firstDefined(props, [
    'dispatched', 'Dispatched', 'dispatch_time', 'DispatchTime', 'date', 'Date', 'time_dispatched'
  ]) || '';

  const description = firstDefined(props, [
    'description', 'Description', 'descr', 'remarks', 'Remarks', 'details',
    'incidentsubtype', 'IncidentSubtype'
  ]) || '';

  // Prefer epoch-ms fields for sorting when present (new layer uses
  // dispatched_dt / updated_dt; legacy used GE_UPDATETIME).
  const sortRaw = firstDefined(props, [
    'dispatched_dt', 'updated_dt', 'GE_UPDATETIME', 'ge_updatetime'
  ]) || dispatched;

  const incidentno = firstDefined(props, [
    'incidentno', 'IncidentNo', 'incident_no', 'INCIDENTNO'
  ]) || '';

  return {
    id: `ag-${props.OBJECTID || props.objectid || props.FID || incidentno || idx}`,
    incidentno: incidentno ? String(incidentno).trim() : '',
    type: String(displayType).toUpperCase().replace(/^NULL$/i, 'INCIDENT'),
    address,
    municipality,
    station,
    dispatched: formatMaybeDate(dispatched),
    description: description && String(description).toLowerCase() !== 'null' ? String(description) : '',
    cat: classifyIncident(rawCategory, `${displayType} ${description}`),
    lat, lon,
    source: 'arcgis',
    _sortKey: toSortKey(sortRaw)
  };
}

// ---------------------------------------------------------------------
// DATA FETCHING — WebCAD RSS (failover when ArcGIS is down or stale)
// ---------------------------------------------------------------------
async function fetchRss() {
  setSourceStatus('rss', 'connecting');
  for (const url of buildCandidateUrls('rss')) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      const incidents = parseRssFeed(text);
      if (incidents && incidents.length > 0) {
        setSourceStatus('rss', 'live');
        return incidents;
      }
    } catch (err) {
      continue;
    }
  }
  setSourceStatus('rss', 'down');
  return null;
}

function parseRssFeed(xmlText) {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const items = Array.from(doc.querySelectorAll('item'));
    return items.map((item, idx) => normalizeRssItem(item, idx)).filter(Boolean);
  } catch (err) {
    return [];
  }
}

function normalizeRssItem(item, idx) {
  const title = (item.querySelector('title')?.textContent || '').trim();
  const description = (item.querySelector('description')?.textContent || '').trim();
  const pubDate = (item.querySelector('pubDate')?.textContent || '').trim();

  // title examples: "Fire: FIRE INVESTIGATION", "EMS: CARDIAC EMERGENCY",
  // "Traffic: VEHICLE ACCIDENT"
  let rawCategory = '';
  let nature = title;
  const titleMatch = title.match(/^(Fire|EMS|Traffic)\s*:\s*(.+)$/i);
  if (titleMatch) {
    rawCategory = titleMatch[1];
    nature = titleMatch[2].trim();
  }

  // description examples:
  // "COMMERCE DR & DEAD END; UPPER POTTSGROVE; 2026-09-24 @ 16:53:08-Station:STA79;"
  // "LEEDOM ST & GREENWOOD AVE;  JENKINTOWN; Station 382; 2026-09-24 @ 17:04:06;"
  let address = '';
  let municipality = '';
  let station = '';
  let dispatched = '';

  const parts = description.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 1) address = parts[0];
  if (parts.length >= 2) {
    // Second part is usually municipality, sometimes "Station XXX"
    if (/^station\b/i.test(parts[1])) {
      station = parts[1].replace(/^station\s*/i, '').trim();
    } else {
      municipality = parts[1];
    }
  }
  for (const p of parts) {
    const staMatch = p.match(/station\s*:?\s*(.+)/i);
    if (staMatch) station = staMatch[1].trim();
    const timeMatch = p.match(/(\d{4}-\d{2}-\d{2}\s*@\s*\d{1,2}:\d{2}:\d{2})/);
    if (timeMatch) dispatched = timeMatch[1];
  }
  if (!dispatched && pubDate) dispatched = pubDate;

  const displayType = (nature || title || 'INCIDENT').toUpperCase();

  return {
    id: `rss-${idx}-${hashStr(title + description)}`,
    type: displayType,
    address: address || 'Address unavailable',
    municipality,
    station,
    dispatched: formatMaybeDate(dispatched),
    description: '',
    cat: classifyIncident(rawCategory, `${displayType} ${title} ${description}`),
    lat: null,
    lon: null,
    source: 'rss',
    _sortKey: toSortKey(dispatched || pubDate)
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Builds the ordered list of URLs to try for a given feed ('rss' | 'oos' |
// 'incidents'): Worker relay first (if configured), then public CORS proxies.
function buildCandidateUrls(kind) {
  const urls = [];
  const workerBase = CONFIG.sources.worker.baseUrl;
  if (workerBase) urls.push(`${workerBase.replace(/\/+$/, '')}/${kind}`);

  const src = CONFIG.sources[kind];
  if (src && Array.isArray(src.corsProxies)) {
    src.corsProxies.forEach((buildProxyUrl) => urls.push(buildProxyUrl(src.url)));
  }
  return urls;
}

// Units endpoint needs eid + num query params. Worker accepts them on /units;
// public proxies wrap the full upstream URL including the query string.
function buildUnitCandidateUrls(eid, num) {
  const urls = [];
  const workerBase = CONFIG.sources.worker.baseUrl;
  if (workerBase) {
    const base = workerBase.replace(/\/+$/, '');
    urls.push(
      `${base}/units?eid=${encodeURIComponent(eid)}&num=${encodeURIComponent(num)}`
    );
  }
  const upstream =
    `https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp` +
    `?units=1&eid=${encodeURIComponent(eid)}&num=${encodeURIComponent(num)}`;
  const src = CONFIG.sources.units;
  if (src && Array.isArray(src.corsProxies)) {
    src.corsProxies.forEach((buildProxyUrl) => urls.push(buildProxyUrl(upstream)));
  }
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
// DATA FETCHING — WebCAD incident index (eid ↔ incident number)
// ---------------------------------------------------------------------
async function fetchIncidentIndex() {
  for (const url of buildCandidateUrls('incidents')) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const html = await res.text();
      const map = parseIncidentIndexHtml(html);
      if (map.size > 0) {
        state.incidentEidByNum = map;
        return map;
      }
    } catch (err) {
      continue;
    }
  }
  return state.incidentEidByNum;
}

// Parses data-eid / data-num attributes from the county's WebCAD list HTML.
function parseIncidentIndexHtml(html) {
  const map = new Map();
  const re = /data-eid=['"](\d+)['"]\s+data-num=['"]([^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const eid = m[1];
    const num = String(m[2]).trim().toUpperCase();
    if (eid && num) map.set(num, { eid, num });
  }
  // Also accept reversed attribute order
  const re2 = /data-num=['"]([^'"]+)['"]\s+data-eid=['"](\d+)['"]/gi;
  while ((m = re2.exec(html)) !== null) {
    const num = String(m[1]).trim().toUpperCase();
    const eid = m[2];
    if (eid && num && !map.has(num)) map.set(num, { eid, num });
  }
  return map;
}

// ---------------------------------------------------------------------
// DATA FETCHING — units assigned to one incident (lazy, on click)
// ---------------------------------------------------------------------
async function fetchUnitsForIncident(incidentno) {
  const num = String(incidentno || '').trim().toUpperCase();
  if (!num) return { status: 'error', units: [] };

  const meta = state.incidentEidByNum.get(num);
  if (!meta || !meta.eid) {
    // Index may be stale — try refreshing once
    await fetchIncidentIndex();
  }
  const resolved = state.incidentEidByNum.get(num);
  if (!resolved || !resolved.eid) {
    return { status: 'error', units: [], message: 'Incident not found in WebCAD unit index' };
  }

  for (const url of buildUnitCandidateUrls(resolved.eid, resolved.num)) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const html = await res.text();
      const units = parseUnitsHtml(html);
      // County returns a short message when none assigned
      if (/no units are currently assigned/i.test(html)) {
        return { status: 'empty', units: [] };
      }
      if (/invalid incident/i.test(html)) {
        continue;
      }
      if (units.length > 0) return { status: 'ok', units };
      if (units.length === 0 && /u-table|u-msg/i.test(html)) {
        return { status: 'empty', units: [] };
      }
    } catch (err) {
      continue;
    }
  }
  return { status: 'error', units: [], message: 'Could not load unit assignments' };
}

function parseUnitsHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = Array.from(doc.querySelectorAll('table.u-table tbody tr, table tbody tr'));
    const units = [];
    rows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 2) return;
      const unit = (cells[0].textContent || '').replace(/\s+/g, ' ').trim();
      const statusEl = cells[1].querySelector('.u-badge, span') || cells[1];
      const status = (statusEl.textContent || '').replace(/\s+/g, ' ').trim();
      const time = cells[2]
        ? (cells[2].textContent || '').replace(/\s+/g, ' ').trim()
        : '';
      if (unit) units.push({ unit, status, time });
    });
    return units;
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------
// FEED CARD EXPAND — assigned units inline in the live feed column
// ---------------------------------------------------------------------
async function loadAndRenderUnits(inc, unitsEl) {
  if (!unitsEl || !inc) return;

  const num = (inc.incidentno || '').trim().toUpperCase();
  if (!num) {
    unitsEl.innerHTML =
      `<div class="card-units-empty">No incident number — unit list unavailable for this source.</div>`;
    return;
  }

  const cached = state.unitsCache.get(num);
  if (cached && (cached.status === 'ok' || cached.status === 'empty') &&
      (Date.now() - cached.fetchedAt) < 45000) {
    if (cached.status === 'ok') renderUnitsList(unitsEl, cached.units);
    else unitsEl.innerHTML =
      `<div class="card-units-empty">No units currently assigned to this incident.</div>`;
    return;
  }

  unitsEl.innerHTML = `<div class="card-units-loading">Loading assigned units…</div>`;
  state.unitsCache.set(num, { status: 'loading', units: [], fetchedAt: Date.now() });

  const result = await fetchUnitsForIncident(num);
  // Ignore if this card is no longer the expanded one
  if (state.expandedId !== inc.id) return;

  state.unitsCache.set(num, {
    status: result.status,
    units: result.units || [],
    fetchedAt: Date.now()
  });

  if (result.status === 'ok') {
    renderUnitsList(unitsEl, result.units);
  } else if (result.status === 'empty') {
    unitsEl.innerHTML =
      `<div class="card-units-empty">No units currently assigned to this incident.</div>`;
  } else {
    unitsEl.innerHTML =
      `<div class="card-units-empty">${escapeHtml(result.message || 'Unit information unavailable.')}</div>`;
  }
}

function renderUnitsList(container, units) {
  if (!units || units.length === 0) {
    container.innerHTML =
      `<div class="card-units-empty">No units currently assigned to this incident.</div>`;
    return;
  }

  const filtered = filterUnitsByStatus(units, state.unitStatusFilter);
  if (filtered.length === 0) {
    container.innerHTML =
      `<div class="card-units-empty">No units match the “${escapeHtml(state.unitStatusFilter)}” status filter.</div>`;
    return;
  }

  container.innerHTML = `
    <table class="card-units-table">
      <thead><tr><th>Unit</th><th>Status</th><th>Time</th></tr></thead>
      <tbody>
        ${filtered.map((u) => `
          <tr>
            <td class="du-unit">${escapeHtml(u.unit)}</td>
            <td><span class="du-status ${statusClass(u.status)}">${escapeHtml(u.status || '—')}</span></td>
            <td class="du-time">${escapeHtml(u.time || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// Normalize a unit status string into a filter key.
function unitStatusKey(status) {
  const s = String(status || '').toLowerCase();
  if (/arriv|on\s*scene|onscene/.test(s)) return 'arrived';
  if (/enroute|en\s*route|respond/.test(s)) return 'enroute';
  if (/dispatch|assigned|queued/.test(s)) return 'dispatched';
  if (/clear|available|transport|returning/.test(s)) return 'clear';
  return 'other';
}

function statusClass(status) {
  const key = unitStatusKey(status);
  if (key === 'arrived') return 's-arrived';
  if (key === 'enroute') return 's-enroute';
  if (key === 'dispatched') return 's-dispatched';
  if (key === 'clear') return 's-clear';
  return 's-other';
}

function filterUnitsByStatus(units, filter) {
  if (!filter || filter === 'all') return units || [];
  return (units || []).filter((u) => unitStatusKey(u.status) === filter);
}

// True if cached unit data for this incident includes at least one unit
// matching the active unit-status filter (or filter is "all").
function incidentMatchesUnitFilter(inc) {
  if (!state.unitStatusFilter || state.unitStatusFilter === 'all') return true;
  const num = (inc.incidentno || '').trim().toUpperCase();
  if (!num) return false;
  const cached = state.unitsCache.get(num);
  if (!cached || cached.status === 'loading' || cached.status === 'error') {
    // Unknown — still show so the user can expand and load units
    return true;
  }
  if (cached.status === 'empty') return false;
  return filterUnitsByStatus(cached.units, state.unitStatusFilter).length > 0;
}

// ---------------------------------------------------------------------
// OVERLAYS — power outages + 511 road / winter / planned events
// ---------------------------------------------------------------------
// gis.montcopa.org GeoJSON has no Access-Control-Allow-Origin, so the
// browser blocks a direct fetch from GitHub Pages. Prefer the Worker
// relay, then public CORS proxies, then a direct attempt last.
function overlayCandidateUrls(key, upstreamUrl) {
  const list = [];
  const workerBase = CONFIG.sources.worker && CONFIG.sources.worker.baseUrl;
  if (workerBase) {
    list.push(`${workerBase.replace(/\/+$/, '')}/overlay/${key}`);
  }
  list.push(`https://api.allorigins.win/raw?url=${encodeURIComponent(upstreamUrl)}`);
  list.push(`https://corsproxy.io/?url=${encodeURIComponent(upstreamUrl)}`);
  list.push(upstreamUrl);
  return list;
}

async function fetchJsonOverlay(key, upstreamUrl) {
  const candidates = overlayCandidateUrls(key, upstreamUrl);
  let lastErr = null;
  for (const url of candidates) {
    try {
      const sep = url.includes('?') ? '&' : '?';
      const res = await fetch(url + sep + '_ts=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      const data = JSON.parse(cleaned);
      if (!data || typeof data !== 'object') throw new Error('not an object');
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('overlay fetch failed: ' + key);
}

async function fetchOverlays() {
  const urls = CONFIG.sources.overlays || {};
  const jobs = [
    ['power', urls.powerOutages, normalizePowerOutages],
    ['road', urls.roadConditions, normalizeRoadConditions],
    ['winter', urls.winterConditions, normalizeWinterConditions],
    ['events', urls.plannedEvents, normalizePlannedEvents]
  ];

  const results = await Promise.allSettled(
    jobs.map(([key, upstream]) =>
      upstream ? fetchJsonOverlay(key, upstream) : Promise.resolve(null)
    )
  );

  const items = [];
  results.forEach((result, i) => {
    if (result.status !== 'fulfilled' || !result.value) {
      if (result.status === 'rejected') {
        console.warn('[montcoxplr] overlay failed:', jobs[i][0], result.reason);
      }
      return;
    }
    try {
      items.push(...jobs[i][2](result.value));
    } catch (err) {
      console.warn('[montcoxplr] overlay normalize failed:', jobs[i][0], err);
    }
  });
  return items;
}

function normalizePowerOutages(fc) {
  const features = fc.features || [];
  return features.map((f, idx) => {
    const p = f.properties || {};
    const customersOut = Number(p.customers_out) || 0;
    if (customersOut <= 0) return null; // only active outages
    const severity = outageSeverity(p.percent_out, customersOut);
    const c = centroidOfGeometry(f.geometry);
    if (!c) return null;
    const util = p.primary_utility || p.utilities || 'Utility';
    const pct = p.percent_out != null ? `${p.percent_out}%` : '';
    const etr = p.etr && p.etr !== 'ETR-NULL' ? `ETR ${p.etr}` : 'ETR unknown';
    return {
      id: `outage-${p.municipality || idx}`,
      incidentno: '',
      type: `POWER OUTAGE — ${String(util).toUpperCase()}`,
      address: `${customersOut} customers out${pct ? ` (${pct})` : ''}`,
      municipality: p.municipality || '',
      station: '',
      dispatched: p.last_updated ? formatMaybeDate(p.last_updated) : '',
      description: `${etr}${p.customers_out_is_estimate ? ' · estimate' : ''}`,
      cat: 'outage',
      severity,
      lat: c.lat,
      lon: c.lon,
      geometry: f.geometry,
      source: 'outage',
      _sortKey: toSortKey(p.last_updated) || Date.now()
    };
  }).filter(Boolean);
}

function normalizeRoadConditions(fc) {
  const features = fc.features || [];
  return features.map((f, idx) => {
    const p = f.properties || {};
    let lat = null, lon = null;
    if (f.geometry && f.geometry.type === 'Point') {
      [lon, lat] = f.geometry.coordinates;
    } else {
      const c = centroidOfGeometry(f.geometry);
      if (c) { lat = c.lat; lon = c.lon; }
    }
    if (lat == null || lon == null) return null;
    const eventType = (p.eventType || p.severity || 'road condition').toUpperCase();
    const lane = p.laneStatus || p.severity || '';
    return {
      id: `road511-${p.eventID || idx}`,
      incidentno: p.eventID ? String(p.eventID) : '',
      type: `511 ${eventType}${lane ? ' — ' + String(lane).toUpperCase() : ''}`,
      address: p.facility || p.description || 'Road condition',
      municipality: p.incidentMuniName || p.countyName || '',
      station: '',
      dispatched: p.lastUpdate || p.createTime || '',
      description: p.description || '',
      cat: 'road511',
      severity: String(p.severity || lane || '').toLowerCase(),
      lat, lon,
      geometry: null,
      source: 'road511',
      _sortKey: toSortKey(p.lastUpdate || p.createTime) || Date.now()
    };
  }).filter(Boolean);
}

function normalizeWinterConditions(fc) {
  const features = fc.features || [];
  return features.map((f, idx) => {
    const p = f.properties || {};
    const cond = String(p.condition || p.condClass || 'Unknown');
    // Skip fully clear segments to reduce map noise (still available if filter set)
    const isClear = /^clear$/i.test(cond) || /^clear$/i.test(p.condClass || '');
    if (isClear) return null;
    const c = centroidOfGeometry(f.geometry);
    if (!c) return null;
    return {
      id: `winter-${p.roadSectionID || idx}`,
      incidentno: p.roadSectionID ? String(p.roadSectionID) : '',
      type: `WINTER — ${cond.toUpperCase()}`,
      address: p.facility || [p.fromLoc, p.toLoc].filter(Boolean).join(' → ') || 'Road section',
      municipality: p.countyName || '',
      station: '',
      dispatched: p.lastUpdate || '',
      description: [p.fromLoc, p.toLoc].filter(Boolean).join(' → '),
      cat: 'winter',
      severity: String(p.condClass || cond).toLowerCase(),
      lat: c.lat,
      lon: c.lon,
      geometry: f.geometry,
      source: 'winter',
      _sortKey: toSortKey(p.lastUpdate) || Date.now()
    };
  }).filter(Boolean);
}

function normalizePlannedEvents(fc) {
  const features = fc.features || [];
  return features.map((f, idx) => {
    const p = f.properties || {};
    let lat = null, lon = null;
    if (f.geometry && f.geometry.type === 'Point') {
      [lon, lat] = f.geometry.coordinates;
    } else {
      const c = centroidOfGeometry(f.geometry);
      if (c) { lat = c.lat; lon = c.lon; }
    }
    if (lat == null || lon == null) return null;
    const title = p.eventType || p.description || p.facility || 'Planned event';
    return {
      id: `planned-${p.eventID || idx}`,
      incidentno: p.eventID ? String(p.eventID) : '',
      type: `PLANNED — ${String(title).toUpperCase()}`,
      address: p.facility || p.description || 'Planned event',
      municipality: p.incidentMuniName || p.countyName || '',
      station: '',
      dispatched: p.lastUpdate || p.createTime || '',
      description: p.description || '',
      cat: 'planned',
      severity: String(p.severity || '').toLowerCase(),
      lat, lon,
      geometry: f.geometry && f.geometry.type !== 'Point' ? f.geometry : null,
      source: 'planned',
      _sortKey: toSortKey(p.lastUpdate || p.createTime) || Date.now()
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------
// REFRESH ORCHESTRATION
// ---------------------------------------------------------------------
async function refreshAll() {
  setSourceStatus('arcgis', 'connecting');
  setRefreshCountdown();

  // Refresh eid↔incidentno index in parallel (used by the units panel).
  fetchIncidentIndex().catch(() => {});

  let combined = [];
  let activeSource = null;

  // 1) Prefer live, non-stale ArcGIS (has coordinates for the map).
  const arcgisIncidents = await fetchArcgis();
  if (arcgisIncidents && arcgisIncidents.length) {
    combined = arcgisIncidents;
    activeSource = 'arcgis';
  }

  // 2) Fall back to live WebCAD RSS when ArcGIS is down or frozen.
  if (combined.length === 0) {
    const rssIncidents = await fetchRss();
    if (rssIncidents && rssIncidents.length) {
      combined = rssIncidents;
      activeSource = 'rss';
    }
  } else {
    // ArcGIS won — mark RSS idle rather than "connecting".
    if (state.sourceStatus.rss === 'connecting') setSourceStatus('rss', 'down');
  }

  // 3) Merge county overlays (outages + 511) — never block CAD if they fail.
  try {
    const overlayItems = await fetchOverlays();
    if (overlayItems && overlayItems.length) {
      combined = combined.concat(overlayItems);
    }
  } catch (err) {
    console.warn('[montcoxplr] overlay fetch failed', err);
  }

  if (combined.length === 0 && CONFIG.demoAfterFailedSources) {
    combined = getDemoIncidents();
    activeSource = 'demo';
    state.isDemo = true;
  } else {
    state.isDemo = false;
  }

  state.activeIncidentSource = activeSource;

  combined.sort(compareFeedOrder);

  // Only diff against real (non-demo) data — otherwise an outage followed
  // by recovery would make every currently-active incident look "new"
  // again just because demo/rss IDs briefly replaced them.
  if (!state.isDemo) {
    detectAndAlertNewIncidents(combined);
  }

  state.incidents = combined;

  // Refresh the primary status chip now that activeIncidentSource is known.
  if (activeSource === 'arcgis' || activeSource === 'rss') {
    setSourceStatus(activeSource, 'live');
  } else if (activeSource === 'demo') {
    const primaryLbl = document.getElementById('lbl-arcgis');
    const primaryDot = document.getElementById('dot-arcgis');
    if (primaryLbl) primaryLbl.textContent = 'DEMO DATA · OFFLINE';
    if (primaryDot) primaryDot.className = 'dot down';
  }

  const demoBanner = document.getElementById('demo-banner');
  if (demoBanner) {
    if (state.isDemo) {
      demoBanner.textContent = '⚠ Live feeds unreachable — showing sample data';
      demoBanner.classList.add('show');
    } else if (activeSource === 'rss') {
      demoBanner.textContent = '⚠ ArcGIS map feed stale/offline — using live WebCAD RSS (list only, no map pins)';
      demoBanner.classList.add('show');
    } else {
      demoBanner.classList.remove('show');
    }
  }

  renderMarkers();
  renderStats();
  renderFeedList();
  renderTicker();
}

// ---------------------------------------------------------------------
// RENDER: stats / feed list / ticker
// ---------------------------------------------------------------------
function renderStats() {
  const counts = {
    fire: 0, ems: 0, traffic: 0,
    outage: 0, road511: 0, winter: 0, planned: 0, other: 0
  };
  state.incidents.forEach((i) => { counts[i.cat] = (counts[i.cat] || 0) + 1; });
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  set('stat-all', state.incidents.length);
  set('stat-fire', counts.fire);
  set('stat-ems', counts.ems);
  set('stat-traffic', counts.traffic);
  set('stat-outage', counts.outage);
  set('stat-road511', counts.road511);
  set('stat-winter', counts.winter);
  set('stat-planned', counts.planned);
}

function renderFeedList() {
  const list = document.getElementById('feed-list');
  const filtered = state.incidents.filter((i) => {
    if (state.activeFilter !== 'all' && i.cat !== state.activeFilter) return false;
    return incidentMatchesUnitFilter(i);
  });

  if (filtered.length === 0) {
    const catBit = state.activeFilter === 'all' ? '' : state.activeFilter.toUpperCase() + ' ';
    const unitBit = state.unitStatusFilter === 'all' ? '' : ` WITH UNIT STATUS “${state.unitStatusFilter.toUpperCase()}”`;
    list.innerHTML = `<div class="feed-empty">NO ${catBit}INCIDENTS${unitBit} ACTIVE</div>`;
    return;
  }

  list.innerHTML = filtered.slice(0, 80).map((i) => {
    const expanded = i.id === state.expandedId;
    return `
    <div class="incident-card ${i.id === state.selectedId ? 'selected' : ''} ${expanded ? 'expanded' : ''}"
         data-cat="${i.cat}" data-id="${i.id}" aria-expanded="${expanded}">
      <div class="top-row">
        <div class="type">${escapeHtml(i.type)}</div>
        <div class="time">${escapeHtml(relativeTime(i._sortKey))}</div>
      </div>
      <div class="loc">${escapeHtml(i.address)}${i.municipality ? ' · ' + escapeHtml(i.municipality) : ''}</div>
      ${i.description ? `<div class="desc">${escapeHtml(i.description)}</div>` : ''}
      <div class="meta">
        ${i.incidentno ? `<span>${escapeHtml(i.incidentno)}</span>` : ''}
        ${i.station ? `<span>STA ${escapeHtml(i.station)}</span>` : ''}
        ${i.dispatched ? `<span>${escapeHtml(i.dispatched)}</span>` : ''}
        <span class="${i.lat != null ? 'geo-yes' : 'geo-no'}">${i.lat != null ? 'MAPPED' : 'NO GEO'}</span>
        <span>${i.source.toUpperCase()}</span>
      </div>
      <div class="expand-hint">${expanded ? '▲ Hide units' : '▼ Units / zoom'}</div>
      <div class="card-units" ${expanded ? '' : 'hidden'}>
        <div class="card-units-label">Assigned units</div>
        <div class="card-units-body">
          ${expanded ? '<div class="card-units-loading">Loading assigned units…</div>' : ''}
        </div>
      </div>
    </div>
  `;
  }).join('');

  list.querySelectorAll('.incident-card').forEach((card) => {
    card.addEventListener('click', () => selectIncident(card.dataset.id));
  });

  // Lazy-load units into the expanded card (if any)
  if (state.expandedId) {
    const inc = state.incidents.find((i) => i.id === state.expandedId);
    const body = list.querySelector(
      `.incident-card[data-id="${CSS.escape(state.expandedId)}"] .card-units-body`
    );
    if (inc && body) loadAndRenderUnits(inc, body);
  }
}

function selectIncident(id) {
  const inc = state.incidents.find((i) => i.id === id);
  if (!inc) return;

  // Toggle expand in the feed list: click again collapses.
  const collapsing = state.expandedId === id;
  state.expandedId = collapsing ? null : id;
  state.selectedId = collapsing ? null : id;

  // Zoom / popup only when opening (not when collapsing)
  if (!collapsing && inc.lat != null && inc.lon != null) {
    state.map.flyTo([inc.lat, inc.lon], Math.max(state.map.getZoom(), 15), { animate: true, duration: 0.6 });
    const marker = state.markers.get(inc.id);
    if (marker) {
      setTimeout(() => marker.openPopup(), 350);
    }
  }

  renderFeedList();

  // Keep the expanded card in view inside the feed column
  if (state.expandedId) {
    const card = document.querySelector(
      `.incident-card[data-id="${CSS.escape(state.expandedId)}"]`
    );
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  document.querySelectorAll('.filter-btn[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeFilter = btn.dataset.filter;
      // Keep stat cards in sync
      document.querySelectorAll('.stat-card').forEach((c) => {
        c.classList.toggle('active', c.dataset.cat === state.activeFilter);
      });
      renderMarkers();
      renderFeedList();
    });
  });

  document.querySelectorAll('.filter-btn[data-unit-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-unit-status]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.unitStatusFilter = btn.dataset.unitStatus;
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

// Crest radar icon — soft refresh (data + gentle tone)
function initCrestRefresh() {
  const crest = document.getElementById('crest-refresh');
  if (!crest) return;

  crest.addEventListener('click', () => {
    crest.classList.add('spinning');
    try { playRefreshTone(); } catch (err) { /* audio may be blocked until gesture unlock */ }

    // Soft refresh: incidents + OOS + unit index (does not reset expanded card)
    Promise.all([
      refreshAll(),
      refreshOos()
    ]).finally(() => {
      setTimeout(() => crest.classList.remove('spinning'), 600);
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
  arcgis: 'CAD MAP FEED',
  rss: 'WEB CAD RSS'
};

function setSourceStatus(source, status) {
  state.sourceStatus[source] = status;
  const dot = document.getElementById(`dot-${source}`);
  if (dot) {
    dot.className = 'dot ' + (status === 'live' ? 'live' : status === 'connecting' ? 'degraded' : 'down');
  }

  const lbl = document.getElementById(`lbl-${source}`);
  if (lbl && SOURCE_LABELS[source]) {
    const statusText = status === 'live' ? 'LIVE' : status === 'connecting' ? 'SYNCING' : 'OFFLINE';
    lbl.textContent = `${SOURCE_LABELS[source]} · ${statusText}`;
  }

  // Keep the primary header chip reflecting whichever incident source is active.
  if (source === 'arcgis' || source === 'rss') {
    const primaryDot = document.getElementById('dot-arcgis');
    const primaryLbl = document.getElementById('lbl-arcgis');
    if (primaryLbl && state.activeIncidentSource) {
      const active = state.activeIncidentSource;
      const activeStatus = state.sourceStatus[active] || status;
      const label = active === 'rss' ? 'WEB CAD RSS' : active === 'demo' ? 'DEMO DATA' : 'CAD MAP FEED';
      const statusText = activeStatus === 'live' ? 'LIVE'
        : activeStatus === 'connecting' ? 'SYNCING' : 'OFFLINE';
      primaryLbl.textContent = `${label} · ${statusText}`;
      if (primaryDot) {
        primaryDot.className = 'dot ' + (activeStatus === 'live' ? 'live'
          : activeStatus === 'connecting' ? 'degraded' : 'down');
      }
    }
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

// Lower number = higher in the live feed column (after pin tier).
function categoryPriority(cat) {
  switch (cat) {
    case 'fire': return 1;
    case 'ems': return 2;
    case 'traffic': return 3;
    case 'road511': return 4;
    case 'outage': return 5;
    case 'winter': return 6;
    case 'planned': return 7;
    default: return 8;
  }
}

// True for Fire/EMS/Traffic still inside the pin window (default 5 min).
function isPinnedRecent(inc) {
  if (!inc) return false;
  if (inc.cat !== 'fire' && inc.cat !== 'ems' && inc.cat !== 'traffic') return false;
  const t = inc._sortKey || 0;
  if (!t) return false;
  const pinMs = CONFIG.feedPinMs || 5 * 60 * 1000;
  const age = Date.now() - t;
  return age >= 0 && age < pinMs;
}

// Feed sort:
//  1) Pinned recent Fire/EMS/Traffic at the very top (newest first)
//  2) Everything else by category priority, then newest first
function compareFeedOrder(a, b) {
  const pinA = isPinnedRecent(a) ? 0 : 1;
  const pinB = isPinnedRecent(b) ? 0 : 1;
  if (pinA !== pinB) return pinA - pinB;
  if (pinA === 0) {
    // Within the pin band: pure recency so the newest call jumps to #1
    return (b._sortKey || 0) - (a._sortKey || 0);
  }
  const pa = categoryPriority(a.cat);
  const pb = categoryPriority(b.cat);
  if (pa !== pb) return pa - pb;
  return (b._sortKey || 0) - (a._sortKey || 0);
}

// Re-apply pin/priority order without refetching (lets pins expire on time).
function resortFeedList() {
  if (!state.incidents || state.incidents.length === 0) return;
  state.incidents.sort(compareFeedOrder);
  renderFeedList();
  renderTicker();
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
