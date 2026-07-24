// Initialize the Leaflet map centered over Montgomery County, PA
const map = L.map('map').setView([40.15, -75.35], 11);

// Add OpenStreetMap base tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Function to fetch and load live Montgomery County 911 incidents
async function loadActiveIncidents() {
    // Montgomery County Open Data GeoJSON endpoint for live 911 CAD incidents
    const arcGisApiUrl = "https://opendata.arcgis.com/api/v3/datasets/b438c9b5aa684ccc87c6f0058d3ff6f6_0/downloads/data?format=geojson&spatialRefId=4326";

    try {
        const response = await fetch(arcGisApiUrl);
        
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const geojsonData = await response.json();
        
        // Clear existing incident markers from the map before plotting fresh updates
        if (window.incidentLayer) {
            map.removeLayer(window.incidentLayer);
        }

        // Add the retrieved GeoJSON incident data points to the map
        window.incidentLayer = L.geoJSON(geojsonData, {
            pointToLayer: function (feature, latlng) {
                return L.circleMarker(latlng, {
                    radius: 6,
                    fillColor: "#ff7800",
                    color: "#000",
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.8
                });
            },
            onEachFeature: function (feature, layer) {
                const props = feature.properties || {};
                const incidentType = props.incidenttype || props.type || "Unknown Incident";
                const location = props.location || "Unknown Location";
                const municipality = props.mun || "";
                const timestamp = props.dispatched || "Unknown Time";
                
                layer.bindPopup(`
                    <strong>${incidentType}</strong><br>
                    Location: ${location} ${municipality ? '(' + municipality + ')' : ''}<br>
                    Dispatched: ${timestamp}
                `);
            }
        }).addTo(map);

        console.log(`Successfully loaded ${geojsonData.features.length} active incidents.`);
        
    } catch (error) {
        console.error("Error loading active incidents from ArcGIS Open Data:", error);
    }
}

// Automatically refresh incidents every 4 minutes (240000 ms) to align with county CAD updates
setInterval(loadActiveIncidents, 240000);

// Initial load trigger on startup
loadActiveIncidents();
