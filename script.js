// ==========================
// 1. INITIALISATION CARTE
// ==========================
const map = L.map('map', { zoomControl: false }).setView([12.75, -16.2667], 9.5);
L.control.zoom({ position: 'bottomleft' }).addTo(map);

L.control.locate({
    position: 'bottomleft',
    strings: { title: "Afficher ma position" },
    drawCircle: true,
    showPopup: false,
    locateOptions: { enableHighAccuracy: true }
}).addTo(map);

const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' });
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: '© Esri' });
osm.addTo(map);

const aeroportIcon = L.icon({
    iconUrl: "https://cdn-icons-png.flaticon.com/512/684/684908.png",
    iconSize: [20, 20],
    iconAnchor: [10, 20],
    popupAnchor: [0, -20]
});

const baseMaps = { "OpenStreetMap": osm, "Satellite": satellite };
const layerControl = L.control.layers(baseMaps, null, { collapsed: false }).addTo(map);

let coucheDepartement, coucheRoutes, coucheLocalites, coucheAeroport;
let suggestionsList = [];
let currentPosition = null;

// ==========================
// 2. EXPORT PDF
// ==========================
function exportFeatureToPDF(properties, type) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(`Fiche d'information – ${type}`, 14, 20);
    doc.setFontSize(11);
    const rows = [];
    for (let [key, value] of Object.entries(properties)) {
        if (value !== undefined && value !== null && value !== "") {
            rows.push([key, String(value)]);
        }
    }
    doc.autoTable({
        startY: 30,
        head: [['Propriété', 'Valeur']],
        body: rows,
        theme: 'striped',
        headStyles: { fillColor: [44, 62, 80] },
        margin: { left: 14, right: 14 }
    });
    doc.save(`export_${type}_${Date.now()}.pdf`);
}

// ==========================
// 3. RECHERCHE & ITINÉRAIRE
// ==========================
function findPlaceInLayers(placeName) {
    if (placeName === "Ma position" && currentPosition) {
        return {
            lat: currentPosition.lat,
            lon: currentPosition.lng,
            displayName: "Ma position",
            type: "Position actuelle"
        };
    }
    if (!placeName || placeName.trim() === "") return null;
    const nameLower = placeName.trim().toLowerCase();
    
    function getCoordinates(feature) {
        if (!feature || !feature.geometry) return null;
        const geom = feature.geometry;
        if (geom.type === "Point") {
            return { lat: geom.coordinates[1], lon: geom.coordinates[0] };
        } else if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
            let coords = geom.type === "Polygon" ? geom.coordinates[0][0] : geom.coordinates[0][0][0];
            return { lat: coords[1], lon: coords[0] };
        }
        return null;
    }
    
    if (coucheLocalites) {
        let result = null;
        coucheLocalites.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                const props = layer.feature.properties;
                const searchValue = (props.search || props.NOM || props.Nom || "").toLowerCase();
                if (searchValue === nameLower) {
                    const coords = getCoordinates(layer.feature);
                    if (coords) result = { ...coords, displayName: props.search || props.NOM || props.Nom, type: "Localité" };
                }
            }
        });
        if (result) return result;
    }
    if (coucheAeroport) {
        let result = null;
        coucheAeroport.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                const props = layer.feature.properties;
                const searchValue = (props.search || props.NOM || props.Nom || "").toLowerCase();
                if (searchValue === nameLower) {
                    const coords = getCoordinates(layer.feature);
                    if (coords) result = { ...coords, displayName: props.search || props.NOM || props.Nom, type: "Aéroport" };
                }
            }
        });
        if (result) return result;
    }
    return null;
}

let currentRouteLayer = null, startMarker = null, endMarker = null;
function clearItinerary() {
    if (currentRouteLayer) { map.removeLayer(currentRouteLayer); currentRouteLayer = null; }
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
    const infoPanel = document.getElementById('routeInfoPanel');
    if (infoPanel) { infoPanel.style.display = 'none'; infoPanel.innerHTML = '<p>Durée: --</p><p>Distance: --</p>'; }
    const errDiv = document.getElementById('routeErrorMsg');
    if (errDiv) errDiv.innerText = '';
}

async function getRouteOSRM(startLonLat, endLonLat) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLonLat.lon},${startLonLat.lat};${endLonLat.lon},${endLonLat.lat}?overview=full&geometries=geojson&steps=false`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        return { geometry: route.geometry, duration: route.duration, distance: route.distance };
    }
    throw new Error("Aucun itinéraire trouvé");
}

async function showRouteBetween(startAddr, endAddr) {
    clearItinerary();
    const infoPanel = document.getElementById('routeInfoPanel');
    const errorDiv = document.getElementById('routeErrorMsg');
    if (infoPanel) { infoPanel.style.display = 'block'; infoPanel.innerHTML = `<p><span>⏳ Recherche des lieux...</span><span class="loading-spinner"></span></p>`; }
    if (errorDiv) errorDiv.innerText = '';
    
    const startGeo = findPlaceInLayers(startAddr);
    const endGeo = findPlaceInLayers(endAddr);
    
    if (!startGeo) { if (errorDiv) errorDiv.innerText = `⚠️ Départ introuvable : "${startAddr}"`; if (infoPanel) infoPanel.style.display = 'none'; return; }
    if (!endGeo) { if (errorDiv) errorDiv.innerText = `⚠️ Arrivée introuvable : "${endAddr}"`; if (infoPanel) infoPanel.style.display = 'none'; return; }
    
    if (infoPanel) infoPanel.innerHTML = `<p><span>🔄 Calcul de l'itinéraire...</span><span class="loading-spinner"></span></p>`;
    try {
        const routeData = await getRouteOSRM({ lat: startGeo.lat, lon: startGeo.lon }, { lat: endGeo.lat, lon: endGeo.lon });
        currentRouteLayer = L.geoJSON(routeData.geometry, {
            style: { color: '#ff9800', weight: 5, opacity: 0.9, dashArray: '8, 8' }
        }).addTo(map);
        startMarker = L.marker([startGeo.lat, startGeo.lon], { icon: L.divIcon({ html: '🚩', iconSize: [24, 24], className: 'start-marker-icon' }), title: "Départ" }).bindPopup(`<b>Départ :</b> ${startAddr}<br><small>${startGeo.type}</small>`).addTo(map);
        endMarker = L.marker([endGeo.lat, endGeo.lon], { icon: L.divIcon({ html: '🏁', iconSize: [24, 24], className: 'end-marker-icon' }), title: "Arrivée" }).bindPopup(`<b>Arrivée :</b> ${endAddr}<br><small>${endGeo.type}</small>`).addTo(map);
        let distanceKm = (routeData.distance / 1000).toFixed(1);
        let durationMin = Math.round(routeData.duration / 60);
        let heures = Math.floor(durationMin / 60);
        let minutes = durationMin % 60;
        let durationText = heures > 0 ? `${heures}h ${minutes}min` : `${minutes} min`;
        if (infoPanel) {
            infoPanel.innerHTML = `<p><span>📏 Distance :</span> <strong>${distanceKm} km</strong></p><p><span>⏱️ Durée :</span> <strong>${durationText}</strong></p><p><span>📍 Départ :</span> ${startAddr}</p><p><span>🏁 Arrivée :</span> ${endAddr}</p>`;
            infoPanel.style.display = 'block';
        }
        const routeBounds = currentRouteLayer.getBounds();
        if (routeBounds.isValid()) map.fitBounds(routeBounds, { padding: [50, 50] });
        else map.setView([(startGeo.lat + endGeo.lat)/2, (startGeo.lon + endGeo.lon)/2], 11);
    } catch (err) {
        if (errorDiv) errorDiv.innerText = `❌ Impossible de tracer l'itinéraire. Réessayez.`;
        if (infoPanel) infoPanel.style.display = 'none';
    }
}

// ==========================
// 4. PANNEAU ITINÉRAIRE (drawer)
// ==========================
function createItineraryDrawer() {
    const drawerDiv = document.createElement('div');
    drawerDiv.id = 'itineraryDrawer';
    drawerDiv.className = 'itinerary-drawer';
    drawerDiv.innerHTML = `
        <div class="drawer-content">
            <div class="itinerary-tab-container">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <div class="itinerary-header" style="border-bottom: none; margin-bottom: 0; padding-bottom: 0;">
                        <span class="route-icon">🧭</span>
                        <h4 style="margin:0;">Planifier un itinéraire</h4>
                    </div>
                    <button id="closeDrawerBtn" style="background: none; border: none; font-size: 1.2rem; cursor: pointer; color: #666;" title="Fermer le panneau">✖</button>
                </div>
                <div class="itinerary-input-group">
                    <label>🚀 Départ</label>
                    <div class="input-with-location">
                        <input type="text" id="startInput" list="suggestionsList" placeholder="Ex: Ziguinchor, Bignona..." autocomplete="off">
                        <button type="button" id="useMyLocationStart" class="location-btn" title="Utiliser ma position actuelle">📍</button>
                    </div>
                </div>
                <div class="itinerary-input-group">
                    <label>🏁 Arrivée</label>
                    <div class="input-with-location">
                        <input type="text" id="endInput" list="suggestionsList" placeholder="Ex: Ziguinchor, Diouloulou..." autocomplete="off">
                        <button type="button" id="useMyLocationEnd" class="location-btn" title="Utiliser ma position actuelle">📍</button>
                    </div>
                </div>
                <datalist id="suggestionsList"></datalist>
                <div class="itinerary-buttons">
                    <button id="calcRouteBtn" class="btn-route">📌 Itinéraire</button>
                    <button id="clearRouteBtn" class="btn-route btn-clear">🗑 Effacer</button>
                </div>
                <div id="routeInfoPanel" class="route-info">
                    <p>Durée: --</p>
                    <p>Distance: --</p>
                </div>
                <div id="routeErrorMsg" class="error-message" style="display: block;"></div>
            </div>
        </div>
    `;
    document.getElementById('map').appendChild(drawerDiv);
    
    function getCurrentPosition(callback) {
        if (currentPosition) { callback(currentPosition); return; }
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                    callback(currentPosition);
                },
                (error) => { alert("Erreur de géolocalisation."); callback(null); },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        } else { alert("Géolocalisation non supportée."); callback(null); }
    }
    
    function updateSuggestions() {
        const datalist = document.getElementById('suggestionsList');
        if (datalist) {
            datalist.innerHTML = '';
            suggestionsList.forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                datalist.appendChild(option);
            });
        }
    }
    const checkInterval = setInterval(() => {
        if (suggestionsList.length > 0) { updateSuggestions(); clearInterval(checkInterval); }
    }, 500);
    
    setTimeout(() => {
        const startInput = document.getElementById('startInput'), endInput = document.getElementById('endInput');
        const calcBtn = document.getElementById('calcRouteBtn'), clearBtn = document.getElementById('clearRouteBtn');
        const closeBtn = document.getElementById('closeDrawerBtn'), drawer = document.getElementById('itineraryDrawer');
        const useMyLocationStart = document.getElementById('useMyLocationStart'), useMyLocationEnd = document.getElementById('useMyLocationEnd');
        if (useMyLocationStart) useMyLocationStart.addEventListener('click', () => { getCurrentPosition((pos) => { if (pos) startInput.value = "Ma position"; }); });
        if (useMyLocationEnd) useMyLocationEnd.addEventListener('click', () => { getCurrentPosition((pos) => { if (pos) endInput.value = "Ma position"; }); });
        if (calcBtn) calcBtn.addEventListener('click', async () => {
            let startVal = startInput?.value.trim(), endVal = endInput?.value.trim();
            if (!startVal || !endVal) { document.getElementById('routeErrorMsg').innerText = '⚠️ Saisissez les deux destinations.'; return; }
            if (startVal.toLowerCase() === endVal.toLowerCase() && startVal !== "Ma position") { document.getElementById('routeErrorMsg').innerText = '⚠️ Les destinations doivent être différentes.'; return; }
            if ((startVal === "Ma position" || endVal === "Ma position") && !currentPosition) { document.getElementById('routeErrorMsg').innerText = "⚠️ Position actuelle non disponible. Cliquez sur 📍 pour l'obtenir."; return; }
            await showRouteBetween(startVal, endVal);
        });
        if (clearBtn) clearBtn.addEventListener('click', () => { clearItinerary(); if(startInput) startInput.value=''; if(endInput) endInput.value=''; document.getElementById('routeErrorMsg').innerText=''; const infoPanel = document.getElementById('routeInfoPanel'); if(infoPanel) infoPanel.style.display='none'; });
        if (closeBtn) closeBtn.addEventListener('click', () => { if (drawer) drawer.classList.remove('drawer-visible'); });
    }, 50);
}

// ==========================
// 5. BOUTON OUTILS (ouvrir le drawer)
// ==========================
function addToolsButton() {
    const toolsControl = L.control({ position: 'topleft' });
    toolsControl.onAdd = function() {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const btn = L.DomUtil.create('button', 'custom-tools-button', container);
        btn.innerHTML = '<i class="fas fa-compass"></i>';
        btn.title = 'Planifier un itinéraire';
        L.DomEvent.disableClickPropagation(container);
        btn.onclick = (e) => { e.stopPropagation(); const drawer = document.getElementById('itineraryDrawer'); if (drawer) drawer.classList.toggle('drawer-visible'); };
        return container;
    };
    toolsControl.addTo(map);
}

// ==========================
// 6. SUIVI GPS TEMPS RÉEL
// ==========================
let watchId = null, currentPositionMarker = null, tracePoints = [], tracePolyline = null;
const traceStyle = { color: '#1E88E5', weight: 4, opacity: 0.8, dashArray: '8, 8' };
const gpsMarkerIcon = L.divIcon({ html: '<div style="background-color: #1E88E5; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px black;"></div>', iconSize: [18, 18], className: 'gps-marker' });
function startGPSFollow() {
    if (watchId !== null) return;
    if (tracePolyline) map.removeLayer(tracePolyline);
    tracePoints = [];
    watchId = navigator.geolocation.watchPosition(
        (position) => {
            const lat = position.coords.latitude, lng = position.coords.longitude, accuracy = position.coords.accuracy;
            currentPosition = { lat, lng };
            tracePoints.push({ lat, lng });
            if (!currentPositionMarker) currentPositionMarker = L.marker([lat, lng], { icon: gpsMarkerIcon, title: "Position suivie" }).bindPopup(`<b>📍 Suivi temps réel</b><br>Lat: ${lat.toFixed(6)}<br>Lng: ${lng.toFixed(6)}<br>Précision: ${Math.round(accuracy)} m`).addTo(map);
            else currentPositionMarker.setLatLng([lat, lng]);
            if (tracePolyline) map.removeLayer(tracePolyline);
            tracePolyline = L.polyline(tracePoints.map(p=>[p.lat,p.lng]), traceStyle).addTo(map);
            map.setView([lat, lng], map.getZoom());
        },
        (error) => { alert("Erreur GPS"); stopGPSFollow(); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
    const toggleBtn = document.getElementById('startStopTrackingBtn');
    if (toggleBtn) { toggleBtn.innerHTML = '<i class="fas fa-stop"></i>'; toggleBtn.title = 'Arrêter le suivi GPS'; toggleBtn.style.color = '#dc3545'; }
}
function stopGPSFollow() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    const toggleBtn = document.getElementById('startStopTrackingBtn');
    if (toggleBtn) { toggleBtn.innerHTML = '<i class="fas fa-play"></i>'; toggleBtn.title = 'Démarrer le suivi GPS (temps réel)'; toggleBtn.style.color = '#28a745'; }
}
function clearTrace() {
    if (tracePolyline) { map.removeLayer(tracePolyline); tracePolyline = null; }
    tracePoints = [];
}
function addRealTimeTrackingButton() {
    const controlDiv = L.control({ position: 'bottomleft' });
    controlDiv.onAdd = function() {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        container.style.backgroundColor = 'white'; container.style.borderRadius = '4px'; container.style.boxShadow = '0 1px 5px rgba(0,0,0,0.4)'; container.style.width = '34px';
        const toggleBtn = L.DomUtil.create('button', 'leaflet-bar-part', container);
        toggleBtn.id = 'startStopTrackingBtn'; toggleBtn.innerHTML = '<i class="fas fa-play"></i>'; toggleBtn.title = 'Démarrer le suivi GPS'; toggleBtn.style.cssText = 'padding:0; width:34px; height:34px; cursor:pointer; border:none; background:white; color:#28a745; font-size:16px; display:flex; align-items:center; justify-content:center; border-bottom:1px solid #ccc';
        const clearBtn = L.DomUtil.create('button', 'leaflet-bar-part', container);
        clearBtn.innerHTML = '<i class="fas fa-eraser"></i>'; clearBtn.title = 'Effacer la trace'; clearBtn.style.cssText = 'padding:0; width:34px; height:34px; cursor:pointer; border:none; background:white; color:#6c757d; font-size:16px; display:flex; align-items:center; justify-content:center';
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(toggleBtn, 'click', () => { if (watchId === null) startGPSFollow(); else stopGPSFollow(); });
        L.DomEvent.on(clearBtn, 'click', () => { clearTrace(); });
        return container;
    };
    controlDiv.addTo(map);
}

// ==========================
// 7. NOUVEAU : OUTIL DE MESURE (surfaces & distances segmentées)
// ==========================
let drawnItems = L.featureGroup().addTo(map);
let measurementLabels = L.layerGroup().addTo(map);
let drawControl;

function addSegmentLabels(layer, latlngs, isClosed = false) {
    const points = [...latlngs];
    if (isClosed && points.length > 1) points.push(points[0]);
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i], p2 = points[i+1];
        const distance = p1.distanceTo(p2);
        if (distance < 0.5) continue;
        const midLat = (p1.lat + p2.lat) / 2;
        const midLng = (p1.lng + p2.lng) / 2;
        const labelText = distance.toFixed(2) + " m";
        const labelIcon = L.divIcon({
            html: `<div class="measure-label">${labelText}</div>`,
            iconSize: [null, null],
            className: 'measure-label-div'
        });
        const marker = L.marker([midLat, midLng], { icon: labelIcon, interactive: false });
        measurementLabels.addLayer(marker);
        if (!layer._measureLabelRefs) layer._measureLabelRefs = [];
        layer._measureLabelRefs.push(marker);
    }
}

function removeLabelsFromLayer(layer) {
    if (layer._measureLabelRefs) {
        layer._measureLabelRefs.forEach(label => measurementLabels.removeLayer(label));
        layer._measureLabelRefs = [];
    }
}

function showMeasurementInfo(layer, type, areaM2 = null, perimeterM = null, totalLengthM = null) {
    let content = "";
    if (type === "polygon") {
        const acres = (areaM2 / 4046.8564224).toFixed(2);
        content = `<b>📐 Surface & Périmètre</b><br>📏 Superficie: <strong>${acres} acres</strong> (${areaM2.toFixed(1)} m²)<br>📏 Périmètre: <strong>${perimeterM.toFixed(2)} m</strong>`;
        const toast = document.getElementById('measurementToast');
        toast.innerHTML = `<i class="fas fa-draw-polygon"></i> Surface: ${acres} ac | Périmètre: ${perimeterM.toFixed(2)} m`;
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 4000);
    } else {
        const km = totalLengthM / 1000;
        const displayDist = km >= 1 ? `${km.toFixed(2)} km` : `${totalLengthM.toFixed(2)} m`;
        content = `<b>📏 Longueur totale</b><br>✏️ Distance: <strong>${displayDist}</strong>`;
        const toast = document.getElementById('measurementToast');
        toast.innerHTML = `<i class="fas fa-ruler"></i> Distance: ${displayDist}`;
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 4000);
    }
    layer.bindPopup(content).openPopup();
}

function onDrawCreated(e) {
    const layer = e.layer;
    drawnItems.addLayer(layer);
    let latlngs;
    if (layer instanceof L.Polygon) {
        latlngs = layer.getLatLngs()[0];
        const area = L.GeometryUtil.geodesicArea(latlngs);
        const perimeter = L.GeometryUtil.length(latlngs);
        addSegmentLabels(layer, latlngs, true);
        showMeasurementInfo(layer, "polygon", area, perimeter);
    } 
    else if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
        latlngs = layer.getLatLngs();
        const totalLen = L.GeometryUtil.length(latlngs);
        addSegmentLabels(layer, latlngs, false);
        showMeasurementInfo(layer, "polyline", null, null, totalLen);
    }
}

function onDrawDeleted(e) {
    e.layers.eachLayer(layer => {
        removeLabelsFromLayer(layer);
    });
}

function setupMeasurementTool() {
    drawControl = new L.Control.Draw({
        position: 'topleft',
        draw: {
            polygon: {
                shapeOptions: { color: '#ff9800', weight: 4, opacity: 0.7, fillColor: '#ff9800', fillOpacity: 0.2 },
                metric: true,
                allowIntersection: false,
                drawError: { color: '#e1e100', message: 'Intersection non autorisée' },
                icon: new L.DivIcon({ html: '<i class="fas fa-draw-polygon"></i>', iconSize: [26, 26] })
            },
            polyline: {
                shapeOptions: { color: '#2c7fb8', weight: 4, opacity: 0.8 },
                metric: true,
                icon: new L.DivIcon({ html: '<i class="fas fa-ruler-combined"></i>', iconSize: [26, 26] })
            },
            rectangle: false,
            circle: false,
            circlemarker: false,
            marker: false
        },
        edit: {
            featureGroup: drawnItems,
            remove: true
        }
    });
    map.addControl(drawControl);
    map.on('draw:created', onDrawCreated);
    map.on('draw:deleted', onDrawDeleted);
    
    const clearMeasControl = L.control({ position: 'bottomleft' });
    clearMeasControl.onAdd = function() {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        container.style.backgroundColor = 'white'; container.style.borderRadius = '4px'; container.style.marginTop = '10px';
        const clearBtn = L.DomUtil.create('button', 'leaflet-bar-part', container);
        clearBtn.innerHTML = '<i class="fas fa-trash-alt"></i>';
        clearBtn.title = 'Effacer toutes les mesures';
        clearBtn.style.cssText = 'width:34px; height:34px; border:none; background:white; cursor:pointer; font-size:16px; color:#d9534f;';
        L.DomEvent.disableClickPropagation(container);
        clearBtn.onclick = () => {
            drawnItems.eachLayer(layer => removeLabelsFromLayer(layer));
            drawnItems.clearLayers();
            measurementLabels.clearLayers();
            const toast = document.getElementById('measurementToast');
            toast.innerHTML = '<i class="fas fa-check"></i> Toutes les mesures supprimées';
            toast.style.display = 'block';
            setTimeout(() => { toast.style.display = 'none'; }, 2000);
        };
        return container;
    };
    clearMeasControl.addTo(map);
}

// ==========================
// 8. CHARGEMENT DES COUCHES GÉOJSON
// ==========================
async function ajouterCouches() {
    try {
        let deptRes = await fetch("data/Zig_geo.geojson");
        let deptData = await deptRes.json();
        coucheDepartement = L.geoJSON(deptData, { style: { color: "black", weight: 2, fillOpacity: 0 }, interactive: false });
        layerControl.addOverlay(coucheDepartement, "Départements");
    } catch(e) { console.warn("GeoJSON Département non chargé", e); }
    try {
        let routeRes = await fetch("data/Route.geojson");
        let routeData = await routeRes.json();
        coucheRoutes = L.geoJSON(routeData, {
            style: { color: "red", weight: 3 },
            onEachFeature: (feature, layer) => {
                const props = feature.properties;
                let contenu = "<b>Route</b><br>";
                for (let cle in props) contenu += `<b>${cle}:</b> ${props[cle]}<br>`;
                contenu += `<div class="popup-buttons"><button class="export-pdf-btn" data-type="Route" data-props='${JSON.stringify(props)}'>📄 Exporter PDF</button><button class="close-popup-btn">❌ Fermer</button></div>`;
                layer.bindPopup(contenu);
                layer.on('popupopen', () => {
                    const container = document.querySelector('.leaflet-popup-content');
                    if(!container) return;
                    const exportBtn = container.querySelector('.export-pdf-btn');
                    const closeBtn = container.querySelector('.close-popup-btn');
                    if(exportBtn) exportBtn.addEventListener('click', (e) => { e.stopPropagation(); const propsJson = exportBtn.getAttribute('data-props'); exportFeatureToPDF(JSON.parse(propsJson), "Route"); });
                    if(closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); layer.closePopup(); });
                });
            }
        }).addTo(map);
        layerControl.addOverlay(coucheRoutes, "Routes");
    } catch(e) { console.warn("GeoJSON Routes non chargé", e); }
    try {
        let locRes = await fetch("data/Localité.geojson");
        let locData = await locRes.json();
        coucheLocalites = L.geoJSON(locData, {
            pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 5, fillColor: "green", color: "black", weight: 1, fillOpacity: 0.8 }),
            onEachFeature: (feature, layer) => {
                const props = feature.properties;
                const nom = props.NOM || props.Nom || "Localité";
                props.search = nom; props.type = "📍 Localité";
                let contenu = "<b>Localité</b><br>";
                for (let cle in props) contenu += `<b>${cle}:</b> ${props[cle]}<br>`;
                contenu += `<div class="popup-buttons"><button class="export-pdf-btn" data-type="Localité" data-props='${JSON.stringify(props)}'>📄 Exporter PDF</button><button class="close-popup-btn">❌ Fermer</button></div>`;
                layer.bindPopup(contenu);
                layer.on('popupopen', () => {
                    const container = document.querySelector('.leaflet-popup-content');
                    if(!container) return;
                    const exportBtn = container.querySelector('.export-pdf-btn');
                    const closeBtn = container.querySelector('.close-popup-btn');
                    if(exportBtn) exportBtn.addEventListener('click', (e) => { e.stopPropagation(); const propsJson = exportBtn.getAttribute('data-props'); exportFeatureToPDF(JSON.parse(propsJson), "Localité"); });
                    if(closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); layer.closePopup(); });
                });
                if (nom && !suggestionsList.includes(nom)) suggestionsList.push(nom);
            }
        }).addTo(map);
        layerControl.addOverlay(coucheLocalites, "Localités");
    } catch(e) { console.warn("GeoJSON Localité non chargé", e); }
    try {
        let aeroRes = await fetch("data/Aeoport.geojson");
        let aeroData = await aeroRes.json();
        coucheAeroport = L.geoJSON(aeroData, {
            pointToLayer: (feature, latlng) => L.marker(latlng, { icon: aeroportIcon }),
            onEachFeature: (feature, layer) => {
                const props = feature.properties;
                const nom = props.NOM || props.Nom || "Aéroport";
                props.search = nom;
                let contenu = "<b>Aéroport</b><br>";
                for (let cle in props) contenu += `<b>${cle}:</b> ${props[cle]}<br>`;
                contenu += `<div class="popup-buttons"><button class="export-pdf-btn" data-type="Aéroport" data-props='${JSON.stringify(props)}'>📄 Exporter PDF</button><button class="close-popup-btn">❌ Fermer</button></div>`;
                layer.bindPopup(contenu);
                layer.on('popupopen', () => {
                    const container = document.querySelector('.leaflet-popup-content');
                    if(!container) return;
                    const exportBtn = container.querySelector('.export-pdf-btn');
                    const closeBtn = container.querySelector('.close-popup-btn');
                    if(exportBtn) exportBtn.addEventListener('click', (e) => { e.stopPropagation(); const propsJson = exportBtn.getAttribute('data-props'); exportFeatureToPDF(JSON.parse(propsJson), "Aéroport"); });
                    if(closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); layer.closePopup(); });
                });
                if (nom && !suggestionsList.includes(nom)) suggestionsList.push(nom);
            }
        }).addTo(map);
        layerControl.addOverlay(coucheAeroport, "Aéroports");
    } catch(e) { console.warn("GeoJSON Aéroport non chargé", e); }

    var coucheRecherche = L.layerGroup([coucheLocalites, coucheAeroport, coucheDepartement, coucheRoutes].filter(c => c));
    var searchAll = new L.Control.Search({
        position: 'topleft',
        layer: coucheRecherche,
        propertyName: 'search',
        marker: false,
        initial: false,
        caseSensitive: false,
        textPlaceholder: '🔎 Rechercher (N5, Bignona, Ziguinchor...)',
        buildTip: function(text, val) {
            var props = (val.layer && val.layer.feature) ? val.layer.feature.properties : {};
            var type = props.type || '';
            var name = props.search || props.NOM || props.Nom || text || 'Résultat';
            return '<a href="#"><b>' + type + '</b><br>' + name + '</a>';
        },
        moveToLocation: function(latlng, title, map) {
            map.flyTo(latlng, 14, { animate: true, duration: 1.5 });
        }
    });
    searchAll.addTo(map);
}

// ==========================
// 9. LANCEMENT DE TOUTES LES FONCTIONNALITÉS
// ==========================
createItineraryDrawer();
addToolsButton();
addRealTimeTrackingButton();
setupMeasurementTool();
ajouterCouches();
