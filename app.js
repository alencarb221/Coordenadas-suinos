const origin = [-26.7216162, -53.5273722];
let farms = [];

const map = L.map('map', { zoomControl: false }).setView(origin, 9);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles &copy; Esri' });
const satelliteRoadLayer = L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { attribution: 'Road data &copy; Esri' });
let satelliteActive = false;

const originIcon = L.divIcon({ className: 'custom-pin origin-pin', html: '<span>F</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
const primaryIcon = L.divIcon({ className: 'custom-pin primary-pin', html: '<span>A</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
const candidateIcon = L.divIcon({ className: 'custom-pin candidate-pin', html: '<span>B</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
const possibilityIcon = L.divIcon({ className: 'custom-pin possibility-pin', html: '<span>+</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
L.marker(origin, { icon: originIcon, zIndexOffset: 1000 }).addTo(map).bindTooltip('Fábrica de ração · São Miguel do Oeste', { permanent: true, direction: 'top', offset: [0, -14], className: 'selection-label' });

const routeLayer = L.layerGroup().addTo(map);
const selectionLayer = L.layerGroup().addTo(map);
const possibilityLayer = L.layerGroup().addTo(map);
const manualPointLayer = L.layerGroup().addTo(map);
const farmOptions = document.getElementById('farmOptions');
const primaryInput = document.getElementById('primary');
const selectedList = document.getElementById('selectedList');
const candidateCount = document.querySelector('.candidate-count');
const selected = [];
let farmsLoaded = false;
let routeAnalysisInProgress = false;
const supabaseClient = window.supabase?.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
let baseFarms = [];
let farmRefreshQueued = false;
let manualPointSelection = null;
const manualPointColors = {
  1: '#2475b9',
  2: '#2fbf71'
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function refreshFarmSources() {
  farmOptions.innerHTML = '';
  farms.sort((first, second) => first.name.localeCompare(second.name, 'pt-BR', { sensitivity: 'base' }));
  farms.forEach((farm) => {
    const option = document.createElement('option');
    option.value = `${farm.name} · ${farm.city}`;
    farmOptions.appendChild(option);
  });
  document.querySelector('.nav-count').textContent = farms.length;
  document.querySelector('.draft-badge').textContent = `${farms.length} pontos carregados`;
  renderIntegratedTable();
}

function scheduleFarmRefresh() {
  if (farmRefreshQueued) return;
  farmRefreshQueued = true;
  requestAnimationFrame(() => {
    farmRefreshQueued = false;
    refreshFarmSources();
  });
}

function renderMapSelection() {
  selectionLayer.clearLayers();
  possibilityLayer.clearLayers();
  routeLayer.clearLayers();
}

function renderRoutePoints(primaryFarm, selectedCandidates) {
  selectionLayer.clearLayers();
  L.marker(primaryFarm.coords, { icon: primaryIcon, zIndexOffset: 1000 }).addTo(selectionLayer).bindTooltip(`A · ${escapeHtml(primaryFarm.name)} · ${escapeHtml(primaryFarm.city)}`, { permanent: true, direction: 'top', offset: [0, -14], className: 'selection-label' });
  selectedCandidates.forEach((farm) => {
    L.marker(farm.coords, { icon: candidateIcon, zIndexOffset: 1000 }).addTo(selectionLayer).bindTooltip(`B · ${escapeHtml(farm.name)} · ${escapeHtml(farm.city)}`, { permanent: true, direction: 'top', offset: [0, -14], className: 'selection-label' });
  });
}

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { values.push(value.trim()); value = ''; }
    else value += character;
  }
  values.push(value.trim());
  return values;
}

function parseCoordinate(value) {
  const match = String(value || '').replace(/\u00a0/g, ' ').match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const coords = [Number(match[1]), Number(match[2])];
  return coords[0] >= -34 && coords[0] <= -25 && coords[1] >= -58 && coords[1] <= -48 ? coords : null;
}

function integratedName(name) {
  return String(name || '')
    .replace(/\s*(?:-\s*)?(?:\(\s*)?GP\s*0*\d+\s*(?:\))?\s*$/i, '')
    .replace(/\s+TP\s*\d+\s*$/i, '')
    .trim();
}

function googleMapsPointUrl([latitude, longitude]) {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

function googleMapsDirectionsUrl(points) {
  const [start, ...rest] = points;
  const destination = rest[rest.length - 1];
  const waypoints = rest.slice(0, -1);
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', start.join(','));
  url.searchParams.set('destination', destination.join(','));
  if (waypoints.length) url.searchParams.set('waypoints', waypoints.map((point) => point.join(',')).join('|'));
  url.searchParams.set('travelmode', 'driving');
  return url.toString();
}

async function loadFarms() {
  if (!supabaseClient) throw new Error('Configuração do Supabase não carregada');
  const { data, error } = await supabaseClient.from('integrados').select('nome, cidade, latitude, longitude').order('nome');
  if (error) throw error;
  const remoteFarms = data.map((row) => ({ name: row.nome, city: row.cidade, coords: [row.latitude, row.longitude] }));
  const localFarms = Array.isArray(window.INTEGRATED_DATA) ? window.INTEGRATED_DATA : [];
  const remoteNames = new Set(remoteFarms.map((farm) => normalizeText(farm.name)));
  const missingFarms = localFarms.filter((farm) => !remoteNames.has(normalizeText(farm.name)));
  if (missingFarms.length) {
    const { error: seedError } = await supabaseClient.from('integrados').insert(missingFarms.map((farm) => ({ nome: farm.name, cidade: farm.city, latitude: farm.coords[0], longitude: farm.coords[1] })));
    if (seedError) throw seedError;
  }
  farms = [...remoteFarms, ...missingFarms];
  baseFarms = farms;
  refreshFarmSources();
  farmsLoaded = true;
  primaryInput.placeholder = 'Digite o nome do integrado';
  document.querySelectorAll('.candidate-input').forEach((input) => { input.placeholder = 'Digite para adicionar'; });
}

function renderIntegratedTable() {
  const body = document.getElementById('integratedTableBody');
  if (!body) return;
  const query = normalizeText(document.getElementById('integratedSearch')?.value);
  const visibleFarms = farms.filter((farm) => [farm.name, farm.city].some((value) => normalizeText(value).includes(query)));
  document.getElementById('integratedTotal').textContent = `${visibleFarms.length} de ${farms.length} integrados`;
  body.innerHTML = visibleFarms.map((farm) => `<tr><td><span class="table-dot"></span>${escapeHtml(farm.name)}</td><td>${escapeHtml(farm.city)}</td><td>${farm.coords[0].toFixed(6)}</td><td>${farm.coords[1].toFixed(6)}</td><td><a class="table-action" href="${googleMapsPointUrl(farm.coords)}" target="_blank" rel="noopener">Google Maps</a></td><td class="table-actions"><button class="table-action edit-integrated" type="button" data-name="${escapeHtml(farm.name)}">Editar</button><button class="table-action delete-integrated" type="button" data-name="${escapeHtml(farm.name)}">Excluir</button></td></tr>`).join('');
}

function openIntegratedModal(farm) {
  document.getElementById('integratedModal').hidden = false;
  document.getElementById('modalTitle').textContent = farm ? 'Editar integrado' : 'Novo integrado';
  document.getElementById('integratedId').value = farm?.name || '';
  document.getElementById('integratedName').value = farm?.name || '';
  document.getElementById('integratedCity').value = farm?.city || '';
  document.getElementById('integratedLatitude').value = farm?.coords[0] ?? '';
  document.getElementById('integratedLongitude').value = farm?.coords[1] ?? '';
  document.getElementById('integratedFormError').textContent = '';
  document.getElementById('integratedName').focus();
}

function closeIntegratedModal() {
  document.getElementById('integratedModal').hidden = true;
}

function showView(view) {
  const routeView = document.getElementById('routeView');
  const integratedView = document.getElementById('integratedView');
  const isRouteView = view === 'rota';

  if (routeView) routeView.hidden = !isRouteView;
  if (integratedView) integratedView.hidden = isRouteView;

  document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  if (view === 'integratedView') renderIntegratedTable();
  else setTimeout(() => map.invalidateSize(), 0);
}

document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.addEventListener('click', (event) => {
  event.preventDefault();
  showView(item.dataset.view);
}));
document.getElementById('integratedSearch').addEventListener('input', renderIntegratedTable);
document.getElementById('newIntegrated').addEventListener('click', () => openIntegratedModal());
document.getElementById('closeModal').addEventListener('click', closeIntegratedModal);
document.getElementById('cancelModal').addEventListener('click', closeIntegratedModal);
document.getElementById('integratedModal').addEventListener('click', (event) => { if (event.target.id === 'integratedModal') closeIntegratedModal(); });

document.getElementById('integratedForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const originalName = document.getElementById('integratedId').value;
  const name = document.getElementById('integratedName').value.trim();
  const city = document.getElementById('integratedCity').value.trim();
  const coords = [Number(document.getElementById('integratedLatitude').value), Number(document.getElementById('integratedLongitude').value)];
  const error = document.getElementById('integratedFormError');
  const duplicate = farms.some((farm) => normalizeText(farm.name) === normalizeText(name) && farm.name !== originalName);
  if (!name || !city || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1]) || coords[0] < -34 || coords[0] > -25 || coords[1] < -58 || coords[1] > -48) {
    error.textContent = 'Preencha todos os campos e informe coordenadas válidas.';
    return;
  }
  if (duplicate) { error.textContent = 'Já existe um integrado com este nome.'; return; }
  const updatedFarm = { name, city, coords };
  if (originalName) {
    const index = farms.findIndex((farm) => farm.name === originalName);
    if (index >= 0) farms[index] = updatedFarm;
    const { error: updateError } = await supabaseClient.from('integrados').update({ nome: name, cidade: city, latitude: coords[0], longitude: coords[1] }).eq('nome', originalName);
    if (updateError) { error.textContent = 'Não foi possível atualizar o integrado.'; return; }
  } else {
    const { error: insertError } = await supabaseClient.from('integrados').insert({ nome: name, cidade: city, latitude: coords[0], longitude: coords[1] });
    if (insertError) { error.textContent = 'Não foi possível salvar o integrado.'; return; }
    farms.push(updatedFarm);
  }
  scheduleFarmRefresh();
  renderMapSelection();
  closeIntegratedModal();
});

document.getElementById('integratedTableBody').addEventListener('click', (event) => {
  const button = event.target.closest('.table-action');
  if (!button) return;
  const farm = farms.find((item) => item.name === button.dataset.name);
  if (!farm) return;
  if (button.classList.contains('edit-integrated')) openIntegratedModal(farm);
  if (button.classList.contains('delete-integrated') && window.confirm(`Excluir o integrado ${farm.name}?`)) {
    supabaseClient.from('integrados').delete().eq('nome', farm.name).then(({ error }) => {
      if (error) { window.alert('Não foi possível excluir o integrado.'); return; }
    farms = farms.filter((item) => item.name !== farm.name);
    selected.splice(0, selected.length, ...selected.filter((item) => item.name !== farm.name));
    scheduleFarmRefresh();
    renderSelected();
    renderMapSelection();
    });
  }
});

function findFarm(value) {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  return farms.find((farm) => normalizeText(`${farm.name} · ${farm.city}`) === normalized)
    || farms.find((farm) => normalizeText(farm.name) === normalized)
    || farms.find((farm) => normalizeText(farm.name).startsWith(normalized))
    || farms.find((farm) => normalizeText(farm.name).includes(normalized));
}

loadFarms().catch((error) => {
  document.querySelector('.draft-badge').textContent = 'Erro ao carregar pontos';
  const detail = error?.message ? ` Detalhes: ${error.message}` : '';
  document.querySelector('.subtitle').textContent = `Não foi possível carregar os integrados do Supabase.${detail}`;
  console.error(error);
});

function routeCoordinates(points) {
  return points.map(([latitude, longitude]) => `${longitude},${latitude}`).join(';');
}

async function fetchRouteData(points, includeAlternatives = false) {
  const coordinates = routeCoordinates(points);
  const urls = [
    `/api/route?coordinates=${encodeURIComponent(coordinates)}&alternatives=${includeAlternatives}`,
    `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&alternatives=${includeAlternatives}`
  ];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let lastError;
    for (const url of urls) {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Falha no roteador: ${response.status}`);
        const data = await response.json();
        return data.routes || [];
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } finally {
    clearTimeout(timeout);
  }
}

function createRoutePolyline(geometry, className, color, weight, opacity, dashArray) {
  return L.polyline(geometry, { className, color, weight, opacity, dashArray }).addTo(routeLayer);
}

async function drawRoute(points, className) {
  try {
    const routes = await fetchRouteData(points, false);
    if (!routes.length) throw new Error('Nenhuma rota recebida');
    const route = routes[0];
    const geometry = route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]);
    return {
      layer: createRoutePolyline(geometry, className, '#2475b9', className === 'route-combined' ? 5 : 3, className === 'route-combined' ? .95 : .58, className === 'route-combined' ? null : '8 8'),
      geometry,
      distance: route.distance,
      duration: route.duration,
      usedFallback: false
    };
  } catch (error) {
    console.error('Erro ao consultar o roteador OSRM, exibindo linha reta como aproximação:', error);
    return {
      layer: createRoutePolyline(points, className, '#2475b9', className === 'route-combined' ? 5 : 3, className === 'route-combined' ? .95 : .58, className === 'route-combined' ? null : '8 8'),
      geometry: points,
      distance: null,
      duration: null,
      usedFallback: true
    };
  }
}

async function drawAlternativeRoute(points, className = 'route-alternative') {
  try {
    const routes = await fetchRouteData(points, true);
    if (!routes || routes.length < 2) return null;
    const alternative = routes[1];
    const geometry = alternative.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]);
    return {
      layer: createRoutePolyline(geometry, className, '#d64545', 4, 0.9, '8 8'),
      distance: alternative.distance,
      duration: alternative.duration
    };
  } catch (error) {
    console.error('Erro ao consultar rota alternativa no OSRM:', error);
    return null;
  }
}

function formatDistance(meters) {
  return meters === null ? '—' : `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

function formatDuration(seconds) {
  if (seconds === null) return '—';
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}min` : `${minutes} min`;
}

function haversineDistanceKm(firstPoint, secondPoint) {
  const [lat1, lon1] = firstPoint;
  const [lat2, lon2] = secondPoint;
  const earthRadius = 6371;
  const toRadians = (degree) => degree * (Math.PI / 180);
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const latitude1 = toRadians(lat1);
  const latitude2 = toRadians(lat2);
  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
    + Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2) * Math.cos(latitude1) * Math.cos(latitude2);
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingBetween(start, end) {
  const [startLat, startLng] = start.map((coordinate) => coordinate * Math.PI / 180);
  const [endLat, endLng] = end.map((coordinate) => coordinate * Math.PI / 180);
  const deltaLng = endLng - startLng;
  const y = Math.sin(deltaLng) * Math.cos(endLat);
  const x = Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function isInRouteDirection(point, start, end) {
  const routeDistance = haversineDistanceKm(start, end);
  const pointDistance = haversineDistanceKm(start, point);
  const directionDifference = Math.abs(((bearingBetween(start, point) - bearingBetween(start, end) + 540) % 360) - 180);
  return pointDistance <= routeDistance && directionDifference <= 30;
}

function distanceToSegmentMeters(point, start, end) {
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos(point[0] * Math.PI / 180);
  const pointX = point[1] * longitudeScale;
  const pointY = point[0] * latitudeScale;
  const startX = start[1] * longitudeScale;
  const startY = start[0] * latitudeScale;
  const endX = end[1] * longitudeScale;
  const endY = end[0] * latitudeScale;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared));
  return Math.hypot(pointX - (startX + ratio * deltaX), pointY - (startY + ratio * deltaY));
}

function distanceToRouteMeters(point, geometry) {
  let shortestDistance = Infinity;
  for (let index = 0; index < geometry.length - 1; index += 1) {
    shortestDistance = Math.min(shortestDistance, distanceToSegmentMeters(point, geometry[index], geometry[index + 1]));
  }
  return shortestDistance;
}

function getManualPointValue(pointKey) {
  const lat = Number(document.getElementById(`manualPoint${pointKey}Lat`)?.value);
  const lng = Number(document.getElementById(`manualPoint${pointKey}Lng`)?.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

function getNextManualPointKey() {
  return getManualPointValue(1) ? 2 : 1;
}

async function renderManualDistance() {
  const point1 = getManualPointValue(1);
  const point2 = getManualPointValue(2);
  const output = document.getElementById('manualDistanceValue');
  manualPointLayer.clearLayers();

  if (point1) {
    const point1Marker = L.marker(point1, { title: 'Ponto 1' }).addTo(manualPointLayer);
    point1Marker.bindTooltip('Ponto 1', { permanent: true });
  }
  if (point2) {
    const point2Marker = L.marker(point2, { title: 'Ponto 2' }).addTo(manualPointLayer);
    point2Marker.bindTooltip('Ponto 2', { permanent: true });
  }

  if (point1 && point2) {
    try {
      const routes = await fetchRouteData([point1, point2], false);
      if (routes.length) {
        const route = routes[0];
        const geometry = route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]);
        const routeLine = L.polyline(geometry, { color: '#2fbf71', weight: 4, opacity: 0.9, dashArray: '6 8' }).addTo(manualPointLayer);
        routeLine.bindTooltip(`${(route.distance / 1000).toFixed(1)} km`, { permanent: false, direction: 'top' });
        output.textContent = (route.distance / 1000).toFixed(1);
        return;
      }
    } catch (error) {
      console.error('Erro ao calcular distância da rota manual:', error);
    }

    const fallbackDistance = haversineDistanceKm(point1, point2);
    output.textContent = fallbackDistance.toFixed(1);
    L.polyline([point1, point2], { color: '#2fbf71', weight: 4, opacity: 0.9, dashArray: '6 8' }).addTo(manualPointLayer);
    return;
  }

  output.textContent = '—';
}

function setManualPointFromMap(pointKey, latlng) {
  const latInput = document.getElementById(`manualPoint${pointKey}Lat`);
  const lngInput = document.getElementById(`manualPoint${pointKey}Lng`);
  if (!latInput || !lngInput) return;
  latInput.value = latlng.lat.toFixed(6);
  lngInput.value = latlng.lng.toFixed(6);
  renderManualDistance();
}

function renderSuggestions(stops, routeGeometry) {
  const selectedNames = new Set(stops.slice(1).map((stop) => normalizeText(stop.name)));
  const segments = stops.slice(0, -1).map((stop, index) => [stop.coords, stops[index + 1].coords]);
  const suggestions = farms.filter((farm) => !selectedNames.has(normalizeText(farm.name)) && segments.some(([start, end]) => isInRouteDirection(farm.coords, start, end))).map((farm) => ({ farm, distance: distanceToRouteMeters(farm.coords, routeGeometry) })).filter(({ distance }) => distance <= 5000).sort((first, second) => first.distance - second.distance).slice(0, 8);
  const card = document.getElementById('suggestionsCard');
  const list = document.getElementById('suggestionsList');
  possibilityLayer.clearLayers();
  suggestions.forEach(({ farm }) => {
    L.marker(farm.coords, { icon: possibilityIcon, zIndexOffset: 900 }).addTo(possibilityLayer).bindTooltip(`Possibilidade · ${escapeHtml(farm.name)} · ${escapeHtml(farm.city)}`, { permanent: true, direction: 'top', offset: [0, -14], className: 'selection-label' });
  });
  card.hidden = false;
  document.getElementById('suggestionsCount').textContent = `${suggestions.length} opção${suggestions.length === 1 ? '' : 'ões'}`;
  list.innerHTML = suggestions.length ? suggestions.map(({ farm, distance }) => `<div class="suggestion-item"><div class="suggestion-info"><strong>${escapeHtml(farm.name)}</strong><span>${escapeHtml(farm.city)} · ${formatDistance(distance)} da rota</span></div><button class="suggestion-add" type="button" data-farm-name="${escapeHtml(farm.name)}">Adicionar B</button></div>`).join('') : '<div class="empty-results">Nenhum integrado encontrado em até 5 km da rota.</div>';
}

function renderRouteDetails(stops, legs, direct, combined) {
  const metricGrid = document.getElementById('metricGrid');
  const details = document.getElementById('routeDetails');
  const integratedDistance = legs.slice(1).reduce((total, leg) => total + (leg.distance || 0), 0);
  metricGrid.innerHTML = `<article class="metric-card"><span class="metric-label">Rota direta até A</span><strong>${formatDistance(direct.distance)}</strong><span class="metric-note">Fábrica → ${escapeHtml(stops[stops.length - 1].name)}</span></article><article class="metric-card"><span class="metric-label">Tempo até A</span><strong>${formatDuration(direct.duration)}</strong><span class="metric-note">Sem paradas intermediárias</span></article><article class="metric-card"><span class="metric-label">Distância entre integrados</span><strong>${formatDistance(integratedDistance)}</strong><span class="metric-note">Soma dos trechos entre A e B</span></article>`;
  const rows = legs.map((leg) => `<tr><td><span class="route-role ${leg.fromRole}">${leg.fromRole === 'origin' ? 'F' : leg.fromRole === 'candidate' ? 'B' : 'A'}</span>${escapeHtml(leg.from.name)}</td><td><span class="route-role ${leg.toRole}">${leg.toRole === 'candidate' ? 'B' : 'A'}</span>${escapeHtml(leg.to.name)}</td><td>${formatDistance(leg.distance)}</td><td>${formatDuration(leg.duration)}</td><td class="detour-value">${leg.toRole === 'candidate' ? `Distância entre pontos: ${formatDistance(leg.distance)}` : 'Destino final em A'}</td></tr>`).join('');
  details.innerHTML = `<table><thead><tr><th>Origem</th><th>Destino</th><th>Distância entre pontos</th><th>Tempo de viagem</th><th>Observação</th></tr></thead><tbody>${rows}</tbody></table>`;
  document.getElementById('analysisStatus').textContent = `${stops.length - 1} trecho${stops.length === 2 ? '' : 's'} calculado${stops.length === 2 ? '' : 's'}`;
}

document.getElementById('factoryButton').addEventListener('click', () => map.flyTo(origin, 11, { duration: .7 }));

document.getElementById('openInGoogleMaps').addEventListener('click', () => {
  const primaryFarm = findFarm(primaryInput.value);
  if (!primaryFarm) { window.alert('Selecione o integrado principal antes de abrir no Google Maps.'); return; }
  const points = [origin, ...selected.map((farm) => farm.coords), primaryFarm.coords];
  window.open(googleMapsDirectionsUrl(points), '_blank', 'noopener');
});

document.getElementById('satelliteToggle').addEventListener('click', (event) => {
  satelliteActive = !satelliteActive;
  if (satelliteActive) {
    map.removeLayer(streetLayer);
    map.addLayer(satelliteLayer);
    map.addLayer(satelliteRoadLayer);
  } else {
    map.removeLayer(satelliteLayer);
    map.removeLayer(satelliteRoadLayer);
    map.addLayer(streetLayer);
  }
  event.currentTarget.classList.toggle('is-active', satelliteActive);
  event.currentTarget.textContent = satelliteActive ? 'Mapa padrão' : 'Satélite';
});

document.getElementById('suggestionsList').addEventListener('click', (event) => {
  const button = event.target.closest('.suggestion-add');
  if (!button) return;
  const farm = farms.find((item) => item.name === button.dataset.farmName);
  if (!farm || selected.some((item) => item.name === farm.name)) return;
  selected.push(farm);
  renderSelected();
  renderMapSelection();
  button.textContent = 'Adicionado';
  button.disabled = true;
});

function renderSelected() {
  selectedList.innerHTML = selected.map((farm, index) => `<span class="selected-tag">${escapeHtml(farm.name)}<button type="button" data-index="${index}" aria-label="Remover ${escapeHtml(farm.name)}">×</button></span>`).join('');
  candidateCount.textContent = `${selected.length} selecionado${selected.length === 1 ? '' : 's'}`;
  selectedList.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => { selected.splice(Number(button.dataset.index), 1); renderSelected(); renderMapSelection(); });
  });
}

function addCandidateFromInput(input) {
  if (!farmsLoaded) return false;
  const farm = findFarm(input.value);
  if (!farm || selected.some((item) => item.name === farm.name) || farm.name === findFarm(primaryInput.value)?.name) return false;
  selected.push(farm);
  input.value = '';
  renderSelected();
  renderMapSelection();
  return true;
}

document.getElementById('candidateFields').addEventListener('click', (event) => {
  const button = event.target.closest('.add-candidate');
  if (!button) return;
  const input = button.parentElement.querySelector('.candidate-input');
  addCandidateFromInput(input);
});

primaryInput.addEventListener('input', renderMapSelection);

document.getElementById('addSearchField').addEventListener('click', () => {
  const field = document.createElement('div');
  field.className = 'candidate-entry';
  field.innerHTML = '<div class="select-wrap autocomplete-wrap"><span class="field-icon candidate-icon">+</span><input class="candidate-input" list="farmOptions" autocomplete="off" placeholder="Digite outro integrado"></div><button class="add-button add-candidate" type="button" title="Adicionar integrado" aria-label="Adicionar integrado">+</button>';
  document.getElementById('candidateFields').appendChild(field);
  field.querySelector('input').focus();
});

document.querySelectorAll('.set-manual-point').forEach((button) => {
  button.addEventListener('click', () => {
    manualPointSelection = Number(button.dataset.point);
    button.textContent = `Clique no mapa · Ponto ${manualPointSelection}`;
    button.classList.add('is-active');
    setTimeout(() => {
      button.textContent = 'Definir no mapa';
      button.classList.remove('is-active');
    }, 1500);
  });
});

document.querySelectorAll('#manualPoint1Lat, #manualPoint1Lng, #manualPoint2Lat, #manualPoint2Lng').forEach((input) => {
  input.addEventListener('input', () => {
    renderManualDistance();
  });
});

document.getElementById('clearManualPoints').addEventListener('click', () => {
  document.getElementById('manualPoint1Lat').value = '';
  document.getElementById('manualPoint1Lng').value = '';
  document.getElementById('manualPoint2Lat').value = '';
  document.getElementById('manualPoint2Lng').value = '';
  manualPointSelection = null;
  renderManualDistance();
});

map.on('click', (event) => {
  const targetKey = manualPointSelection || getNextManualPointKey();
  setManualPointFromMap(targetKey, event.latlng);
  renderManualDistance();
  manualPointSelection = null;
});

document.getElementById('clearRoute').addEventListener('click', () => {
  selected.length = 0;
  primaryInput.value = '';
  document.querySelectorAll('.candidate-input').forEach((input) => { input.value = ''; });
  document.querySelectorAll('#candidateFields .candidate-entry:not(:first-child)').forEach((field) => field.remove());
  routeLayer.clearLayers();
  selectionLayer.clearLayers();
  possibilityLayer.clearLayers();
  document.getElementById('suggestionsCard').hidden = true;
  document.getElementById('suggestionsList').innerHTML = '';
  renderSelected();
});

document.getElementById('analyzeRoute').addEventListener('click', async () => {
  if (routeAnalysisInProgress) return;
  document.querySelectorAll('.candidate-input').forEach((input) => addCandidateFromInput(input));
  const primaryFarm = findFarm(primaryInput.value);
  const button = document.getElementById('analyzeRoute');
  if (!farmsLoaded) {
    button.innerHTML = '<span>!</span> Carregando integrados';
    setTimeout(() => { button.innerHTML = '<span>✦</span> Analisar combinação'; }, 2200);
    return;
  }
  if (!primaryFarm) {
    button.innerHTML = '<span>!</span> Selecione o integrado principal';
    setTimeout(() => { button.innerHTML = '<span>✦</span> Analisar combinação'; }, 2200);
    return;
  }
  routeAnalysisInProgress = true;
  button.disabled = true;
  routeLayer.clearLayers();
  const selectedCandidates = selected.length > 0 ? selected : [];
  const primaryPath = [origin, primaryFarm.coords];
  const alternatePath = selectedCandidates.length > 0
    ? [origin, ...selectedCandidates.map((farm) => farm.coords), primaryFarm.coords]
    : null;
  try {
    const directResult = await drawRoute(primaryPath, alternatePath ? 'route-primary' : 'route-combined');
    const combinedResult = alternatePath ? await drawRoute(alternatePath, 'route-combined') : directResult;
    const alternativeResult = await drawAlternativeRoute(alternatePath || primaryPath, 'route-alternative');
    const stops = [{ name: 'Fábrica de ração', coords: origin, role: 'origin' }, ...selectedCandidates.map((farm) => ({ ...farm, role: 'candidate' })), { ...primaryFarm, role: 'primary' }];
    renderRoutePoints(primaryFarm, selectedCandidates);
    const legs = [];
    for (let index = 0; index < stops.length - 1; index += 1) {
      const result = await drawRoute([stops[index].coords, stops[index + 1].coords], 'route-hidden');
      result.layer.remove();
      legs.push({ from: stops[index], to: stops[index + 1], fromRole: stops[index].role, toRole: stops[index + 1].role, distance: result.distance, duration: result.duration, usedFallback: result.usedFallback });
    }
    renderRouteDetails(stops, legs, directResult, combinedResult);
    const analysisStatus = document.getElementById('analysisStatus');
    const hadFallback = directResult.usedFallback || combinedResult.usedFallback || legs.some((leg) => leg.usedFallback);
    analysisStatus.classList.toggle('status-warning', hadFallback);
    if (hadFallback) {
      analysisStatus.textContent = 'Serviço de rotas indisponível: exibindo linha reta e sem km/tempo';
    }
    renderSuggestions(stops, combinedResult.geometry);
    if (alternativeResult) alternativeResult.layer.bringToFront();
    const routePoints = alternatePath || primaryPath;
    map.fitBounds(L.latLngBounds(routePoints), { padding: [55, 55] });
    button.innerHTML = `<span>✓</span> ${alternatePath ? '2 rotas exibidas' : 'Rota exibida'}`;
    setTimeout(() => { button.innerHTML = '<span>✦</span> Analisar combinação'; }, 2200);
  } finally {
    routeAnalysisInProgress = false;
    button.disabled = false;
  }
});
