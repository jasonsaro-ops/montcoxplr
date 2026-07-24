// Initialize the map centered over Montgomery County, PA
const map = L.map('map').setView([40.15, -75.35], 11);

// Add OpenStreetMap base tile layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Layer group to safely clear and update incident markers on refresh
let incidentLayerGroup = L.layerGroup().addTo(map);

// Function to fetch and render live incidents
async function loadActiveIncidents() {
    // Public ArcGIS OpenData GeoJSON endpoint for Montgomery County 911 incidents
    const endpoint = "https://opendata.arcgis.com/api/v3/datasets/b438c9b5aa684ccc87c6f0058d3ff6f6_0/downloads/data?format=geojson&spatialRefId=4326";

    try {
        const response = await fetch(endpoint);
        if (!response.ok) {
            throw new Error(`Network response failed: ${response.status}`);
        }

        const data = await response.json();
        
        // Clear old markers before repopulating
        incidentLayerGroup.clearLayers();

        if (data && data.features) {
            data.features.forEach(feature => {
                if (!feature.geometry || !feature.geometry.coordinates) return;
                
                const coords = [feature.geometry.coordinates[1], feature.geometry.coordinates[0]];
                const props = feature.properties || {};
                
                const incidentType = props.type || props.incidenttype || "Active Incident";
                const location = props.location || "Location Unavailable";
                const timeDispatched = props.dispatched || "Recent";

                // Create circle marker for each event
                const marker = L.circleMarker(coords, {
                    radius: 6,
                    fillColor: "#ef4444",
                    color: "#b91c1c",
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.8
                });

                marker.bindPopup(`
                    <div style="font-size: 12px; line-height: 1.4;">
                        <strong>${incidentType}</strong><br>
                        <strong>Location:</strong> ${location}<br>
                        <strong>Dispatched:</strong> ${timeDispatched}
                    </div>
                `);

                incidentLayerGroup.addLayer(marker);
            });

            console.log(`Loaded ${data.features.length} live incidents successfully.`);
        }
    } catch (error) {
        console.error("Could not load incident data feed:", error);
    }
}

// Initial fetch
loadActiveIncidents();

// Refresh every 4 minutes (240,000 ms) matching county cadence
setInterval(loadActiveIncidents, 240000);
