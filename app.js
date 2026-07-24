// --- MONTCOXPLR Core State & Configuration ---
let countdownVal = 120; // 2-minute refresh loop

let globalIncidentCache = {};
let incidentMapMarkers = {}; 

let activeLeafletMap = null;
let fireMarkersGroup = null;
let emsMarkersGroup = null;
let trafficMarkersGroup = null;

let layerVisibility = { fire: true, ems: true, traffic: true };

// The Montgomery County 911 Incidents ArcGIS GeoJSON URL
const MONTCO_911_URL = "https://data-montcopa.opendata.arcgis.com/datasets/montgomery-county-911-incidents.geojson";

// Sound alert state
let alertSoundEnabled = false;
let previousAlertCount = 0;
let alertAudio = null;

function initAlertSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        alertAudio = audioContext;
    } catch (err) { console.log("Audio context deferred."); }
}

function playAlertSound() {
    if (!alertSoundEnabled || !alertAudio) return;
    try {
        const context = alertAudio;
        if (context.state === 'suspended') context.resume();
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.connect(gain); gain.connect(context.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.2, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.15);
        osc.start(context.currentTime); osc.stop(context.currentTime + 0.15);
    } catch (err) { console.error("Audio error:", err); }
}

// --- Golden Layout Grid Configuration ---
const config = {
    settings: { hasHeaders: true, reorderEnabled: true, showPopoutIcon: false, showMaximiseIcon: true, showCloseIcon: false },
    dimensions: { borderWidth: 1, headerHeight: 32 },
    content: [{
        type: 'row',
        content: [
            {
                type: 'column',
                width: 60,
                content: [
                    { type: 'component', componentName: 'incidentMap', title: 'MONTGOMERY COUNTY ACTIVE INCIDENTS', height: 72 },
                    { type: 'component', componentName: 'activeIncidentList', title: 'LIVE 911 DISPATCHES', height: 28 }
                ]
            },
            {
                type: 'column',
                width: 20,
                content: [
                    { type: 'component', componentName: 'localRadar', title: 'NWS KDIX RADAR (MOUNT HOLLY)', height: 50 },
                    { type: 'component', componentName: 'nwsAlerts', title: 'MONTCO NWS WEATHER WARNINGS', height: 50 }
                ]
            },
            {
                type: 'column',
                width: 20,
                content: [
                    { type: 'component', componentName: 'fireUnits', title: 'ACTIVE FIRE INCIDENTS', height: 50 },
                    { type: 'component', componentName: 'emsUnits', title: 'ACTIVE EMS INCIDENTS', height: 50 }
                ]
            }
        ]
    }]
};

const layout = new GoldenLayout(config, '#desktopLayoutContainer');

// --- Component Registrations ---
layout.registerComponent('incidentMap', function(container) {
    container.getElement().html(`
        <div id="mapHudFrame" style="position:relative; width:100%; height:100%; background:#0a0e14;">
            <div id="mapControls" style="position:absolute; top:10px; left:10px; z-index:1000; background:rgba(10, 14, 20, 0.82); backdrop-filter:blur(4px); border:1px solid rgba(42,50,62,0.8); padding:8px 14px; border-radius:8px; display:flex; gap:8px;">
                <button id="btn-fire" class="btn-control active" style="color:#ff3300; border-color:#ff3300;" onclick="toggleIncidentLayer('fire')"><i class="fa-solid fa-fire"></i> FIRE</button>
                <button id="btn-ems" class="btn-control active" style="color:#35e08a; border-color:#35e08a;" onclick="toggleIncidentLayer('ems')"><i class="fa-solid fa-truck-medical"></i> EMS</button>
                <button id="btn-traffic" class="btn-control active" style="color:#ffcc33; border-color:#ffcc33;" onclick="toggleIncidentLayer('traffic')"><i class="fa-solid fa-car-burst"></i> TRAFFIC</button>
            </div>
            <div id="leafletMapContainer" style="width:100%; height:100%;"></div>
        </div>
    `);
    
    setTimeout(() => {
        if (!activeLeafletMap) {
            // Centered on Montgomery County, PA
            activeLeafletMap = L.map('leafletMapContainer', { zoomControl: false, preferCanvas: true }).setView([40.21, -75.36], 11);
            L.control.zoom({ position: 'bottomright' }).addTo(activeLeafletMap);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(activeLeafletMap);

            fireMarkersGroup = L.layerGroup().addTo(activeLeafletMap);
            emsMarkersGroup = L.layerGroup().addTo(activeLeafletMap);
            trafficMarkersGroup = L.layerGroup().addTo(activeLeafletMap);
        }
        fetchAllData();
    }, 250);
});

layout.registerComponent('activeIncidentList', function(container) {
    container.getElement().html(`<div class="weather-component" id="all-incidents-target">Scanning dispatch feeds...</div>`);
    container.on('open', fetchMontcoData);
});

layout.registerComponent('fireUnits', function(container) {
    container.getElement().html(`<div class="weather-component" id="fire-incidents-target">Waiting for data...</div>`);
});

layout.registerComponent('emsUnits', function(container) {
    container.getElement().html(`<div class="weather-component" id="ems-incidents-target">Waiting for data...</div>`);
});

layout.registerComponent('localRadar', function(container) {
    container.getElement().html(`
        <div class="weather-component" style="padding:0; overflow:hidden; background:#000; position:relative;">
            <img id="kdix-radar-img" src="https://radar.weather.gov/ridge/standard/KDIX_loop.gif" style="width:100%; height:100%; object-fit:cover; object-position:center;" alt="NWS Mount Holly Radar Loop" />
            
            <div style="position:absolute; bottom:5px; left:5px; background:rgba(10,14,20,0.82); backdrop-filter:blur(4px); padding:4px 8px; border-radius:3px; border:1px solid #2a323e; font-size:0.65rem; color:#9aa7b8;">
                <i class="fa-solid fa-satellite-dish" style="color:#2de3c4;"></i> LIVE: NWS KDIX
            </div>
        </div>
    `);

    // Force refresh the NWS radar GIF every 5 minutes (300,000 milliseconds)
    setInterval(() => {
        const radarImg = document.getElementById('kdix-radar-img');
        if (radarImg) {
            radarImg.src = "https://radar.weather.gov/ridge/standard/KDIX_loop.gif?t=" + new Date().getTime();
        }
    }, 300000);
});

layout.registerComponent('nwsAlerts', function(container) {
    container.getElement().html(`
        <div class="weather-component" style="position:relative;">
            <div style="margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #2a323e; display:flex; justify-content:space-between; align-items:center;">
                <div style="font-size:0.8rem; color:#ffcc33; font-weight:700; font-family:'Rajdhani',sans-serif; letter-spacing:0.6px; text-transform:uppercase;"><i class="fa-solid fa-triangle-exclamation"></i> NWS Weather Warnings (PA)</div>
                <button id="soundToggleBtn" onclick="toggleAlertSound()" class="btn-control" style="color:#9aa7b8; padding:2px 6px;" title="Toggle alert audio">
                    <i class="fa-solid fa-volume-mute"></i>
                </button>
            </div>
            <div id="alerts-container">Scanning NWS hazard feeds...</div>
        </div>`);
    container.on('open', fetchNWSAlerts);
});

layout.on('stateChanged', () => { if (activeLeafletMap) activeLeafletMap.invalidateSize(); });
layout.init();

document.addEventListener('click', () => { if (!alertAudio) initAlertSound(); }, { once: true });

function toggleAlertSound() {
    if (!alertAudio) initAlertSound();
    alertSoundEnabled = !alertSoundEnabled;
    const btn = document.getElementById('soundToggleBtn');
    if (btn) {
        if (alertSoundEnabled) {
            btn.style.borderColor = '#35e08a'; btn.style.color = '#35e08a';
            btn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
            playAlertSound();
        } else {
            btn.style.borderColor = '#2a323e'; btn.style.color = '#9aa7b8';
            btn.innerHTML = '<i class="fa-solid fa-volume-mute"></i>';
        }
    }
}

// --- Data Fetching Logic ---
function fetchMontcoData() {
    return fetch(MONTCO_911_URL)
        .then(r => r.json())
        .then(geo => {
            if (fireMarkersGroup) fireMarkersGroup.clearLayers();
            if (emsMarkersGroup) emsMarkersGroup.clearLayers();
            if (trafficMarkersGroup) trafficMarkersGroup.clearLayers();
            
            globalIncidentCache = {};
            const feats = (geo && geo.features) ? geo.features : [];

            feats.forEach((f, idx) => {
                const p = f.properties || {};
                const geom = f.geometry || {};
                let lat = null, lon = null;
                
                if (geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
                    lon = geom.coordinates[0]; lat = geom.coordinates[1];
                }
                
                if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) return;

                const key = `montco-${idx}`;
                // Fallback field logic based on typical ArcGIS schema for CAD feeds
                const incidentType = p.type || p.IncidentType || 'Unknown';
                const subType = p.subtype || p.IncidentSubType || p.description || 'N/A';
                const location = p.address || p.Location || 'Unknown Location';
                const municipality = p.municipality || p.Municipality || p.township || 'N/A';
                const dispatched = p.dispatch_time || p.Dispatched ? new Date(p.dispatch_time || p.Dispatched).toLocaleTimeString() : 'N/A';

                globalIncidentCache[key] = { key, incidentType, subType, location, municipality, dispatched, lat, lon };

                // Determine icon color based on incident type
                let iconColor = '#9aa7b8'; 
                let iconType = 'fa-bell';
                let targetGroup = trafficMarkersGroup;
                let cat = 'TRAFFIC';
                
                if (incidentType.toUpperCase().includes('FIRE')) {
                    iconColor = '#ff3300';
                    iconType = 'fa-fire';
                    targetGroup = fireMarkersGroup;
                    cat = 'FIRE';
                } else if (incidentType.toUpperCase().includes('EMS') || incidentType.toUpperCase().includes('MEDICAL')) {
                    iconColor = '#35e08a';
                    iconType = 'fa-truck-medical';
                    targetGroup = emsMarkersGroup;
                    cat = 'EMS';
                } else {
                    iconColor = '#ffcc33';
                    iconType = 'fa-car-burst';
                    targetGroup = trafficMarkersGroup;
                    cat = 'TRAFFIC';
                }

                globalIncidentCache[key].category = cat;
                globalIncidentCache[key].iconColor = iconColor;

                if (activeLeafletMap) {
                    const markerIcon = L.divIcon({
                        html: `<i class="fa-solid ${iconType}" style="color:${iconColor}; font-size:16px; text-shadow:0 0 4px #000;"></i>`,
                        className: 'incident-icon',
                        iconSize: [16, 16], iconAnchor: [8, 8]
                    });

                    const marker = L.marker([lat, lon], { icon: markerIcon });
                    marker.bindPopup(`
                        <div style="font-family:'Share Tech Mono';">
                            <strong style="color:${iconColor}; font-size:1rem; text-transform:uppercase;"><i class="fa-solid ${iconType}"></i> ${subType}</strong><br>
                            <hr style="border:1px solid #2a323e; margin:6px 0;" />
                            <strong>Location:</strong> ${location}<br>
                            <strong>Municipality:</strong> ${municipality}<br>
                            <strong>Dispatched:</strong> ${dispatched}<br>
                        </div>
                    `);
                    
                    if (cat === 'FIRE' && layerVisibility.fire) targetGroup.addLayer(marker);
                    else if (cat === 'EMS' && layerVisibility.ems) targetGroup.addLayer(marker);
                    else if (cat === 'TRAFFIC' && layerVisibility.traffic) targetGroup.addLayer(marker);
                    
                    globalIncidentCache[key].marker = marker;
                }
            });
            
            renderIncidentLists();
        }).catch(err => {
            console.error("Montco CAD feed error:", err);
            $('#all-incidents-target').html('<span style="color:#ff5555;">CAD FEED UNREACHABLE</span>');
        });
}

function renderIncidentLists() {
    let allHtml = '';
    let fireHtml = '';
    let emsHtml = '';
    
    let incidents = Object.values(globalIncidentCache);
    
    if(incidents.length === 0) {
        let emptyMsg = `<span style="color:#35e08a; font-size:0.8rem;"><i class="fa-solid fa-check"></i> NO ACTIVE INCIDENTS</span>`;
        $('#all-incidents-target').html(emptyMsg);
        $('#fire-incidents-target').html(emptyMsg);
        $('#ems-incidents-target').html(emptyMsg);
        return;
    }

    incidents.forEach(item => {
        let card = `
            <div class="fire-card" style="border-left-color: ${item.iconColor};" onclick="openIncidentOnMap('${item.key}')">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="color:${item.iconColor}; font-weight:bold; font-size:0.85rem; text-transform:uppercase;">${item.subType}</span>
                    <span style="color:#9aa7b8; font-size:0.7rem;">${item.dispatched}</span>
                </div>
                <div style="color:#9aa7b8; font-size:0.7rem; margin-top:3px;">
                    Loc: ${item.location} <br> Area: <strong>${item.municipality}</strong>
                </div>
            </div>`;
            
        allHtml += card;
        if (item.category === 'FIRE') fireHtml += card;
        if (item.category === 'EMS') emsHtml += card;
    });

    $('#all-incidents-target').html(allHtml || '<span style="color:#35e08a; font-size:0.8rem;"><i class="fa-solid fa-check"></i> NO ACTIVE INCIDENTS</span>');
    $('#fire-incidents-target').html(fireHtml || '<span style="color:#35e08a; font-size:0.8rem;"><i class="fa-solid fa-check"></i> NO ACTIVE FIRE INCIDENTS</span>');
    $('#ems-incidents-target').html(emsHtml || '<span style="color:#35e08a; font-size:0.8rem;"><i class="fa-solid fa-check"></i> NO ACTIVE EMS INCIDENTS</span>');
}

function fetchNWSAlerts() {
    const container = $('#alerts-container');
    // Fetching alerts for Pennsylvania
    return fetch('https://api.weather.gov/alerts/active?area=PA&status=actual&message_type=alert')
        .then(res => res.json())
        .then(data => {
            const features = data.features || [];
            // Filter to alerts that likely impact the eastern PA / Montco area (NWS Mount Holly - PHI)
            const alerts = features.filter(f => (f.properties.cwa || []).includes('PHI') || (f.properties.senderName || '').includes('Mount Holly')).slice(0, 15);
            
            let html = ''; let alertCount = alerts.length;

            if (alertCount > 0) {
                alerts.forEach(f => {
                    const id = f.properties.id;
                    const event = f.properties.event || 'Weather Alert';
                    const area = f.properties.areaDesc || 'Unknown Area';
                    const desc = (f.properties.description || '').replace(/'/g, "");
                    
                    html += `
                        <div class="fire-card" style="border-left-color: #ff3333;" onclick="openFloatingModal('${event}', \`<div style='color:#fff; background:#0a0e14; padding:12px; font-family:monospace; font-size:0.85rem; white-space:pre-wrap;'>\${'${desc}'}</div>\` )">
                            <div style="color: #ff5555; font-weight: bold; font-size:0.78rem;">${event.toUpperCase()}</div>
                            <div style="color:#9aa7b8; font-size:0.7rem; margin-top:2px;">${area}</div>
                        </div>`;
                });
            } else { html = "<span style='color:#35e08a; font-size:0.8rem;'><i class='fa-solid fa-check'></i> NO ACTIVE NWS WARNINGS FOR REGION</span>"; }

            if (alertCount > previousAlertCount && alertCount > 0) playAlertSound();
            previousAlertCount = alertCount; container.html(html);
        }).catch(() => container.html('<span style="color:#ff5555; font-size:0.8rem;">ALERT FEED UNREACHABLE</span>'));
}

// --- Interaction Logic ---
function toggleIncidentLayer(type) {
    layerVisibility[type] = !layerVisibility[type];
    
    const btn = document.getElementById(`btn-${type}`);
    if (btn) {
        if (layerVisibility[type]) {
            btn.classList.add('active');
            btn.style.opacity = '1';
            
            // Re-add layers
            if (activeLeafletMap) {
                Object.values(globalIncidentCache).forEach(item => {
                    if (item.category.toLowerCase() === type && item.marker) {
                        if (type === 'fire') fireMarkersGroup.addLayer(item.marker);
                        if (type === 'ems') emsMarkersGroup.addLayer(item.marker);
                        if (type === 'traffic') trafficMarkersGroup.addLayer(item.marker);
                    }
                });
            }
        } else {
            btn.classList.remove('active');
            btn.style.opacity = '0.4';
            
            // Remove layers
            if (type === 'fire' && fireMarkersGroup) fireMarkersGroup.clearLayers();
            if (type === 'ems' && emsMarkersGroup) emsMarkersGroup.clearLayers();
            if (type === 'traffic' && trafficMarkersGroup) trafficMarkersGroup.clearLayers();
        }
    }
}

function openIncidentOnMap(key) {
    const item = globalIncidentCache[key];
    if (!item || !activeLeafletMap || !item.marker) return;
    
    const cat = item.category.toLowerCase();
    
    // Ensure layer is visible before flying to it
    if (!layerVisibility[cat]) {
        toggleIncidentLayer(cat);
    }

    activeLeafletMap.flyTo([item.lat, item.lon], 15, { duration: 1.5 });
    setTimeout(() => item.marker.openPopup(), 1500);
}

function toggleNoradMode() {
    const isOn = document.body.classList.toggle('norad-mode');
    const btn = document.getElementById('noradToggleBtn');
    if (btn) btn.classList.toggle('active', isOn);
    try { localStorage.setItem('montcoxplr_norad', isOn ? '1' : '0'); } catch (e) {}
    if (activeLeafletMap) setTimeout(() => activeLeafletMap.invalidateSize(), 200);
}

(function initNoradPreference() {
    let saved = '0';
    try { saved = localStorage.getItem('montcoxplr_norad') || '0'; } catch (e) {}
    if (saved === '1') {
        document.addEventListener('DOMContentLoaded', () => {
            document.body.classList.add('norad-mode');
            const btn = document.getElementById('noradToggleBtn');
            if (btn) btn.classList.add('active');
        });
    }
})();

function openFloatingModal(title, textHTML) {
    document.getElementById('modalTitle').innerText = title;
    document.getElementById('modalBody').innerHTML = textHTML;
    document.getElementById('hubFloatingModal').style.display = 'flex';
}
function closeFloatingModal() { document.getElementById('hubFloatingModal').style.display = 'none'; document.getElementById('modalBody').innerHTML = ''; }

// --- Sync Timer ---
function fetchAllData() {
    fetchMontcoData();
    fetchNWSAlerts();
}

let syncInterval;
function startSyncTimer() {
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(() => {
        countdownVal--;
        if (countdownVal <= 0) { 
            countdownVal = 120; 
            fetchAllData(); 
        }
        
        const targetTimer = document.getElementById('countdown');
        if (targetTimer) targetTimer.innerText = countdownVal;
        
        const ring = document.getElementById('timerRing');
        if (ring) ring.style.setProperty('--pct', Math.round((countdownVal / 120) * 100));
    }, 1000);
}

startSyncTimer();

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => { clearTimeout(timeout); func(...args); };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}
window.addEventListener('resize', debounce(() => { 
    if (layout && layout.isInitialised) layout.updateSize(); 
}, 150));
