const SPC_URL = 'https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv';
const FALLBACK_URL = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(SPC_URL);
const SUN_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
const MOON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

const state = {
  rows: [],
  spcRows: [],
  filtered: [],
  map: null,
  layerGroup: null,
  datLayerGroup: null,
  editLayerGroup: null,
  editHandles: { start: null, end: null },
  polyLines: new Map(),
  allBounds: null,
  yearMin: 1950,
  yearMax: 2025,
  minMagnitude: 0,
  selectedId: null,
  corrections: new Map(),
  theme: 'dark',
  noaaDatMatches: [],
  spcLayerVisible: true,
  spcOpacity: 0.8,
  spcMultiCountyOnly: false,
  nceiLayerVisible: true,
  nceiOpacity: 0.8,
  datLayerVisible: true,
  datOpacity: 0.9,
  datPointsVisible: true,
  datPathsVisible: true,
  datPolygonsVisible: true,
  countyLayerVisible: true,
  radarStations: [],
  datRenderers: {},
  countyLayer: null,
  radarLayer: null,
  radarType: 'reflectivity', // 'off', 'reflectivity', or 'velocity'
  radarOpacity: 0.65,
  radarOffsetMinutes: 0,
  baseTileLayer: null,
  theme: 'dark',
  radarRequestToken: 0,
  countyGeoJSON: null,
  wfoGeoJSON: null,
};

document.addEventListener('DOMContentLoaded', init);
let currentDatSearchId = 0;

async function init() {
  const mapElement = document.getElementById('map');
  state.map = L.map(mapElement, {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  }).setView([38.5, -98.35], 4);

  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  });
  tiles.addTo(state.map);

  state.map.createPane('countyPane');
  state.map.getPane('countyPane').style.zIndex = 350;

  // Strictly enforce DAT layering order (Polygons bottom, Lines middle, Points top)
  state.map.createPane('datPolygonsPane');
  state.map.getPane('datPolygonsPane').style.zIndex = 405; // Elevated above Canvas (400)
  state.datRenderers.polygons = L.svg({ pane: 'datPolygonsPane' });

  state.map.createPane('datLinesPane');
  state.map.getPane('datLinesPane').style.zIndex = 406; // Elevated above polygons
  state.datRenderers.lines = L.svg({ pane: 'datLinesPane' });

  state.map.createPane('datPointsPane');
  state.map.getPane('datPointsPane').style.zIndex = 407; // Elevated above lines
  state.datRenderers.points = L.svg({ pane: 'datPointsPane' });
  const zoomContainer = document.querySelector('.leaflet-control-zoom');
  if (zoomContainer) {
    const resetBtn = L.DomUtil.create('a', '');
    resetBtn.href = '#';
    resetBtn.title = 'Reset view';
    resetBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-top: 5px;"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`;
    
    L.DomEvent.disableClickPropagation(resetBtn);
    L.DomEvent.on(resetBtn, 'click', function (e) {
      L.DomEvent.stop(e);
      if (state.allBounds && state.allBounds.isValid()) {
        state.map.fitBounds(state.allBounds, { padding: [30, 30] });
      } else {
        zoomToConus();
      }
    });
    
    // Insert it as the very first child so it appears above '+' and '-'
    zoomContainer.insertBefore(resetBtn, zoomContainer.firstChild);
  }

  state.layerGroup = L.layerGroup().addTo(state.map);
  state.datLayerGroup = L.layerGroup().addTo(state.map);
  state.editLayerGroup = L.layerGroup().addTo(state.map);
  
  const updateMarkerScale = () => {
    if (!state.map) return;
    const zoom = state.map.getZoom();
    // Scales from ~0.4 at zoom 4 (National) up to 1.0 at zoom 9+ (County)
    const scale = Math.max(0.4, Math.min(1.0, zoom / 9));
    document.documentElement.style.setProperty('--marker-scale', scale);
  };
  state.map.on('zoom', updateMarkerScale);
  updateMarkerScale(); // initialize on load

  bindControls();
  updateSpcControls();
  applyTheme('dark');
  updateExportButtonLabel();
  loadCountyBoundaries();

  try {
    const rsResponse = await fetch('https://api.weather.gov/radar/stations?stationType=WSR-88D');
    const rsData = await rsResponse.json();
    state.radarStations = rsData.features.map(f => ({
      id: f.properties.id,
      name: f.properties.name,
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0]
    }));
  } catch (err) {
    console.warn('Unable to load NWS radar stations', err);
  }
  await loadData();
}

async function loadData() {
  try {
    let rows = await loadBundledReportParts();

    if (!rows.length) {
      const csvText = await fetchCsvWithFallback();
      const parsed = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => String(header).trim(),
      });

      rows = parsed.data
        .map((row) => normalizeRow(row, 'SPC'))
        .filter(Boolean);
    }

    state.rows = rows
      .sort((a, b) => String(a.beginDate || '').localeCompare(String(b.beginDate || '')) || 
                      String(a.beginTime || '').localeCompare(String(b.beginTime || '')));

    state.spcRows = await loadSpcRows();

    if (!state.rows.length && !state.spcRows.length) {
      throw new Error('No usable tornado rows were found in the bundled CSV files or the SPC CSV.');
    }

    refreshYearBounds(true);
    renderFilteredData({ preserveMapView: true });
    setStatus(`Loaded ${state.rows.length.toLocaleString()} primary report rows and ${state.spcRows.length.toLocaleString()} SPC rows.`);
  } catch (error) {
    console.error(error);
    setStatus(
      'Unable to load the NOAA SPC tornado CSV. Please check the internet connection or upload a local CSV/DAT file.',
      true
    );
  }
}

async function loadBundledReportParts() {
  const fileNames = [
    '1950-2026_Tornado_Reports_part1.csv',
    '1950-2026_Tornado_Reports_part2.csv',
    '1950-2026_Tornado_Reports_part3.csv',
    '1950-2026_Tornado_Reports_part4.csv',
    '1950-2026_Tornado_Reports_part5.csv',
    '1950-2026_Tornado_Reports_part6.csv',
    '1950-2026_Tornado_Reports_part7.csv'
  ];
  
  const loaded = [];

  for (const fileName of fileNames) {
    try {
      const response = await fetch(`./${fileName}`, { cache: 'no-store' });
      if (!response.ok) {
        continue;
      }
      const text = await response.text();
      const parsed = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => String(header).trim(),
      });

      const rows = parsed.data
        .map((row) => normalizeRow(row, 'CSV'))
        .filter(Boolean);

      if (rows.length) {
        loaded.push(...rows);
      }
    } catch (error) {
      console.warn(`Skipping bundled CSV ${fileName}:`, error);
    }
  }

  return loaded;
}

async function fetchCsvWithFallback() {
  try {
    const response = await fetch(SPC_URL, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Primary SPC fetch failed with status ${response.status}`);
    }
    return await response.text();
  } catch (primaryError) {
    console.warn('Primary SPC CSV fetch failed, trying fallback.', primaryError);
    const fallbackResponse = await fetch(FALLBACK_URL, { cache: 'no-store' });
    if (!fallbackResponse.ok) {
      throw new Error(`SPC fallback fetch failed with status ${fallbackResponse.status}`);
    }
    return fallbackResponse.text();
  }
}

async function loadSpcRows() {
  try {
    const csvText = await fetchCsvWithFallback();
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => String(header).trim(),
    });

    return parsed.data
      .map((row) => normalizeRow(row, 'SPC'))
      .filter(Boolean);
  } catch (error) {
    console.warn('Unable to load SPC rows:', error);
    return [];
  }
}

async function loadCountyBoundaries() {
  const countyPath = 'cb_2018_us_county_5m/cb_2018_us_county_5m';
  const wfoPath = 'w_18mr25/w_18mr25'; // Ensure this matches your asset path

  // Load Counties
  try {
    state.countyGeoJSON = await shp(resolveAssetUrl(`${countyPath}.shp`));
  } catch (err) {
    try {
      state.countyGeoJSON = await shp(resolveAssetUrl(countyPath));
    } catch (e) {
      console.warn('Failed to load county shapefile:', e);
    }
  }

  // Load WFOs
  try {
    state.wfoGeoJSON = await shp(resolveAssetUrl(`${wfoPath}.shp`));
  } catch (err) {
    try {
      state.wfoGeoJSON = await shp(resolveAssetUrl(wfoPath));
    } catch (e) {
      console.warn('Failed to load WFO shapefile:', e);
    }
  }

  if (state.countyGeoJSON) {
    state.countyLayer = L.geoJSON(state.countyGeoJSON, {
      pane: 'countyPane',
      style: {
        color: '#64748b', weight: 1, opacity: 0.55, fillColor: 'transparent', interactive: false
      }
    }).addTo(state.map);
  }
}

async function handleTrackSelection(record, preserveMapView = true) {
  if (!record) return;

  if (record.source !== 'CSV') {
    return;
  }

  state.selectedId = record.id;
  renderEditor();
  renderDetailsPanel(record);

  if (state.radarLayer) {
    state.map.removeLayer(state.radarLayer);
    state.radarLayer = null;
  }
  state.radarScans = [];
  state.radarScanIndex = 0;
  state.radarRecordId = null;
  
  // Highlight the selected track without destroying the map layers
  if (state.polyLines) {
    state.polyLines.forEach((layer, id) => {
      const isSelected = (id === state.selectedId);
      if (layer.setStyle) {
        layer.setStyle({
          weight: isSelected ? 6 : 3,
          opacity: isSelected ? 1 : 0.8
        });
      }
    });
  }

  if (state.editLayerGroup) state.editLayerGroup.clearLayers();

  const startIcon = L.divIcon({
    className: 'edit-handle-icon',
    html: `<div style="width:14px; height:14px; background:#007B5Dff; border:2px solid #fff; border-radius:50%; box-shadow:0 2px 6px rgba(0,0,0,0.6); cursor: grab;"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
  const endIcon = L.divIcon({
    className: 'edit-handle-icon',
    html: `<div style="width:14px; height:14px; background:#af0000ff; border:2px solid #fff; border-radius:50%; box-shadow:0 2px 6px rgba(0,0,0,0.6); cursor: grab;"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const startHandle = L.marker([record.beginLatitude, record.beginLongitude], {
    icon: startIcon, draggable: true, zIndexOffset: 1000
  }).addTo(state.editLayerGroup);

  const endHandle = L.marker([record.endLatitude, record.endLongitude], {
    icon: endIcon, draggable: true, zIndexOffset: 1000
  }).addTo(state.editLayerGroup);

  // Add these two lines to store the handles in state so the panel can sync with them:
  state.editHandles.start = startHandle;
  state.editHandles.end = endHandle;
  updateLivePathLength();

  const updateTrackLine = () => {
    const s = startHandle.getLatLng();
    const e = endHandle.getLatLng();
    const path = state.polyLines.get(record.id);
    if (path) path.setLatLngs([s, e]);
  };

  startHandle.on('drag', (e) => {
    const pos = e.target.getLatLng();
    const latInput = document.getElementById('beginLat');
    const lonInput = document.getElementById('beginLon');
    if (latInput) latInput.value = pos.lat.toFixed(4);
    if (lonInput) lonInput.value = pos.lng.toFixed(4);
    updateTrackLine();
    updateLivePathLength();
  });

  endHandle.on('drag', (e) => {
    const pos = e.target.getLatLng();
    const latInput = document.getElementById('endLat');
    const lonInput = document.getElementById('endLon');
    if (latInput) latInput.value = pos.lat.toFixed(4);
    if (lonInput) lonInput.value = pos.lng.toFixed(4);
    updateTrackLine();
    updateLivePathLength();
  });
  // ----------------------------------

  const statusEl = document.getElementById('radarStatus');
  const offsetLabel = document.getElementById('radarOffsetLabel');
  if (statusEl) statusEl.textContent = '';
  if (offsetLabel) offsetLabel.textContent = '--:-- UTC';

  // Only zoom if preserveMapView is explicitly passed as false
  if (!preserveMapView && state.map) {
    zoomToSelectedTrack();
  }

  const dateLabel = record.beginDate || record.endDate || 'this date';
  const searchId = ++currentDatSearchId;

  if (!document.getElementById('spinner-style')) {
    const style = document.createElement('style');
    style.id = 'spinner-style';
    style.innerHTML = `@keyframes dat-spin { 100% { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }

  setStatus(`
    <span style="display:inline-block; width:12px; height:12px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation: dat-spin 0.75s linear infinite; vertical-align: text-bottom; margin-right: 6px;"></span>
    Searching NOAA DAT for ${dateLabel}...
  `);

  const matches = await fetchNoaaDatForTrack(record);

  // If another track was clicked while fetching, bail out cleanly
  if (searchId !== currentDatSearchId) return;

  state.noaaDatMatches = matches || [];
  renderDatLayer(state.noaaDatMatches);
  updateDatLayerSectionVisibility();

  if (matches && matches.length) {
    setStatus(`Selected ${record.reportId || record.id}. DAT found ${matches.length} feature(s).`, false);
  } else {
    setStatus(`Selected ${record.reportId || record.id}. 0 DAT features found.`, false);
  }
  updateIemRadar();
  // When a track is clicked, clear the cached scans and index
  state.radarScans = [];
  state.radarScanIndex = 0;
  state.radarRecordId = null;

  // Only show radar block for primary tracks
  const radarControls = document.getElementById('radarControls');
  if (radarControls) {
    if (record.source === 'CSV' || record.source === 'SPC') {
      radarControls.classList.remove('hidden');
      updateIemRadar();
    } else {
      radarControls.classList.add('hidden');
      if (state.radarLayer) {
        state.map.removeLayer(state.radarLayer);
        state.radarLayer = null;
      }
    }
  }
}

async function loadDatAttachments(layerId, objectId, containerId) {
  const container = document.getElementById(containerId);
  if (!container || container.dataset.loaded) return;

  if (layerId === undefined || objectId === undefined) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = '<div style="text-align:center; padding: 10px; font-size:0.75rem; color:var(--muted); border-top:1px solid var(--border); margin-top: 10px; grid-column: 1 / -1;">Checking for photos...</div>';
  container.dataset.loaded = 'true';

  try {
    const url = `https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/MapServer/${layerId}/${objectId}/attachments?f=json`;
    const resp = await fetch(url, { cache: 'no-store' });
    const data = await resp.json();
    
    if (data && data.attachmentInfos && data.attachmentInfos.length > 0) {
      // Grab the first valid image attachment
      const photo = data.attachmentInfos.find(a => a.contentType.startsWith('image/'));
      if (photo) {
        const imgUrl = `https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/MapServer/${layerId}/${objectId}/attachments/${photo.id}`;
        container.innerHTML = `
          <div style="margin-top: 12px; text-align: center; border-top: 1px solid var(--border); padding-top: 10px; grid-column: 1 / -1;">
            <a href="${imgUrl}" target="_blank">
              <img src="${imgUrl}" alt="DAT Damage Photo" style="max-width: 100%; max-height: 200px; border-radius: 6px; object-fit: contain; background: rgba(0,0,0,0.2);" />
            </a>
            <div style="font-size: 0.7rem; color: var(--muted); margin-top: 4px;">Click image to expand</div>
          </div>
        `;
        return;
      }
    }
    container.innerHTML = ''; // Hide if no photos exist
  } catch (err) {
    console.warn('Failed to fetch DAT attachments', err);
    container.innerHTML = '';
  }
}

async function fetchNoaaDatForTrack(record) {
  if (!record) {
    return [];
  }

  const candidateDates = new Set();
  for (const candidate of [record.beginDate, record.endDate, record.date, record.event_date, record.stormdate, record.damage_date]) {
    const normalized = normalizeDateString(candidate);
    if (normalized) {
      candidateDates.add(normalized);
    }
  }

  if (!candidateDates.size) {
    return [];
  }

  const layerIds = [0, 1, 2];
  const unique = new Map();

  const xMin = Math.min(record.beginLongitude, record.endLongitude) - 0.5;
  const yMin = Math.min(record.beginLatitude, record.beginLatitude) - 0.5;
  const xMax = Math.max(record.beginLongitude, record.endLongitude) + 0.5;
  const yMax = Math.max(record.beginLatitude, record.endLatitude) + 0.5;
  const bbox = `${xMin},${yMin},${xMax},${yMax}`;

  // Extract the target date (e.g. "2013-05-20")
  const targetDate = normalizeDateString(firstNonEmpty(record.beginDate, record.endDate));
  
  // Build a strict date filter for the ArcGIS server
  let whereClause = '1%3D1';
  if (targetDate) {
    const dt = new Date(targetDate);
    
    // We add +12 hours so the date represents Noon UTC, preventing time zone shifts
    const safeDate = new Date(dt.getTime() + (12 * 60 * 60 * 1000)); 
    
    const start = new Date(safeDate.getTime() - 86400000).toISOString().split('T')[0];
    const end = new Date(safeDate.getTime() + 86400000).toISOString().split('T')[0];
    
    // Explicitly use the timestamp keyword matching the Python script format
    whereClause = encodeURIComponent(`stormdate >= timestamp '${start} 00:00:00' AND stormdate <= timestamp '${end} 23:59:59'`);
  }

  for (const layerId of layerIds) {
    // Send both the spatial box AND the date filter to the server
    const url = `https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/MapServer/${layerId}/query?f=geojson&where=${whereClause}&geometry=${bbox}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326`;    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const features = Array.isArray(payload && payload.features) ? payload.features : [];

      for (const feature of features) {
        // Look for .properties (GeoJSON) instead of .attributes
        if (!feature || (!feature.properties && !feature.attributes)) {
          continue;
        }

        const attrs = feature.properties || feature.attributes;
        // Inject IDs for dynamic photo loading later
        attrs._layerId = layerId;
        attrs._objectId = attrs.objectid || attrs.OBJECTID;

        const valueSet = [
          attrs.stormdate,
          attrs.event_date,
          attrs.damage_date,
          attrs.damage_dt,
          attrs.date,
          attrs.begin_date,
          attrs.end_date,
          attrs.issue_date,
          attrs.valid,
          attrs['date'],
        ];

        const matchesDate = valueSet.some((value) => {
          const normalized = normalizeDateString(value);
          return normalized && candidateDates.has(normalized);
        });

        if (!matchesDate) {
          continue;
        }

        const dedupeKey = `${layerId}:${attrs.objectid || attrs.OBJECTID || attrs.event_id || attrs.EVENT_ID || JSON.stringify(feature.geometry)}`;
        if (!unique.has(dedupeKey)) {
          unique.set(dedupeKey, feature);
        }
      }
    } catch (error) {
      console.warn(`DAT layer ${layerId} query failed:`, error);
    }
  }

  return Array.from(unique.values());
}

async function updateIemRadar() {
  const record = getSelectedRecord();
  const statusEl = document.getElementById('radarStatus');
  const scrubber = document.getElementById('radarTimeScrubber');
  const offsetLabel = document.getElementById('radarOffsetLabel');
  const myRequestToken = ++state.radarRequestToken;

  if (state.radarLayer) {
    state.map.removeLayer(state.radarLayer);
    state.radarLayer = null;
  }

  const isPrimaryTrack = record && (record.source === 'CSV' || record.source === 'SPC');

  if (state.radarType === 'off' || !isPrimaryTrack) {
    if (statusEl) statusEl.textContent = '';
    if (scrubber) scrubber.classList.add('hidden');
    return;
  }

  const dateStr = normalizeDateString(record.beginDate || record.endDate);
 
  const timeStr = normalizeTimeString(record.beginTime || '00:00');
  const timeInfo = record.source === 'SPC' ? getSpcRadarTimeInfo(record) : {
    dateStr,
    timeStr,
    offsetMinutes: 0,
    utcDate: new Date(`${normalizeDateString(record.beginDate || record.endDate) || dateStr}T${normalizeTimeString(record.beginTime || '00:00') || timeStr}:00Z`),
  };
  const radarDateStr = timeInfo.dateStr || dateStr;
  const radarTimeStr = timeInfo.timeStr || timeStr;

  const targetDate = timeInfo.utcDate || new Date(`${radarDateStr}T${radarTimeStr}:00Z`);

  if (scrubber) scrubber.classList.remove('hidden');

  // Find nearest radar station
  if (!state.radarStations || !state.radarStations.length) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">Radar station list unavailable.</span>';
    return;
  }

  let nearest = null;
  let minDst = Infinity;
  for (const station of state.radarStations) {
    const d = getDistanceMiles(record.beginLatitude, record.beginLongitude, station.lat, station.lon);
    if (d < minDst) {
      minDst = d;
      nearest = station;
    }
  }

  const site3 = nearest.id.length === 4 ? nearest.id.slice(1) : nearest.id;
  const radarSiteLabel = document.getElementById('radarSiteLabel');
  if (radarSiteLabel) {
    radarSiteLabel.textContent = site3;
  }
  const product = state.radarType === 'reflectivity' ? 'N0B' : 'N0S';
  const typeLabel = state.radarType === 'reflectivity' ? 'Reflectivity' : 'SR Velocity';

  // --- QUERY IEM JSON CATALOG FOR VALID TIMESTAMPS ---
  const trackKey = `${record.id}_${state.radarType}_${site3}`;
  if (state.radarRecordId !== trackKey) {
    if (statusEl) statusEl.textContent = `Finding ${site3} scans...`;

    const startIso = new Date(targetDate.getTime() - 60 * 60 * 1000).toISOString().slice(0, 16) + 'Z';
    const endIso = new Date(targetDate.getTime() + 60 * 60 * 1000).toISOString().slice(0, 16) + 'Z';

    const listUrl = `https://mesonet.agron.iastate.edu/json/radar.py?operation=list&radar=${site3}&product=${product}&start=${startIso}&end=${endIso}`;

    try {
      const resp = await fetch(listUrl);
      const data = await resp.json();
      if (myRequestToken !== state.radarRequestToken) return;

      const scans = (data.scans || []).map(s => s.ts);

      if (!scans.length) {
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger)">No ${typeLabel} scans found for ${site3} in this timeframe.</span>`;
        return;
      }

      state.radarScans = scans;
      state.radarRecordId = trackKey;

      const targetMs = targetDate.getTime();
      let bestIdx = 0;
      let minDiff = Infinity;
      scans.forEach((ts, idx) => {
        const diff = Math.abs(new Date(ts).getTime() - targetMs);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = idx;
        }
      });
      state.radarScanIndex = bestIdx;

      const slider = document.getElementById('radarTimeSlider');
      if (slider) {
        slider.min = '0';
        slider.max = String(scans.length - 1);
        slider.step = '1';
        slider.value = String(bestIdx);
      }
    } catch (err) {
      if (myRequestToken !== state.radarRequestToken) return;
      console.warn('IEM radar list fetch error', err);
      if (statusEl) statusEl.textContent = 'Failed to retrieve scan index from IEM.';
      return;
    }
  }

  if (myRequestToken !== state.radarRequestToken) return;
  if (!state.radarScans || !state.radarScans.length) return;

  const currentTs = state.radarScans[state.radarScanIndex];
  const scanDate = new Date(currentTs);

  const yyyy = scanDate.getUTCFullYear();
  const mm = String(scanDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(scanDate.getUTCDate()).padStart(2, '0');
  const hh = String(scanDate.getUTCHours()).padStart(2, '0');
  const min = String(scanDate.getUTCMinutes()).padStart(2, '0');

  const fullTimeParam = `${yyyy}-${mm}-${dd}T${hh}:${min}:00.000Z`;

  if (offsetLabel) {
    offsetLabel.textContent = `${hh}:${min} UTC (${state.radarScanIndex + 1}/${state.radarScans.length})`;
  }

  const nextLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/ridge.cgi', {
    layers: 'single-archive',
    format: 'image/png',
    transparent: true,
    sector: site3,
    prod: product,
    append: 'bottom',
    year: yyyy,
    month: mm,
    day: dd,
    time: hh + min,
    fullTime: fullTimeParam,
    uppercase: false,
    opacity: state.radarOpacity,
    zIndex: 200,
    tileSize: 1024,
    updateWhenIdle: true
  });

  if (myRequestToken !== state.radarRequestToken) return;

  if (state.radarLayer) {
    state.map.removeLayer(state.radarLayer);
  }
  state.radarLayer = nextLayer;
  state.radarLayer.addTo(state.map);

  if (statusEl) {
    statusEl.textContent = `${typeLabel} (${site3})`;
  }
}

async function fetchStormEventDetails(eventId) {
  if (!eventId) return null;
  try {
    setStatus(`Fetching live NCEI database info for Event ID ${eventId}...`);
    const url = `https://www.ncdc.noaa.gov/stormevents/eventdetails.jsp?id=${eventId}`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    
    const response = await fetch(proxyUrl, { cache: 'no-store' });
    const data = await response.json();
    
    // Parse the HTML response to extract event data
    const parser = new DOMParser();
    const doc = parser.parseFromString(data.contents, 'text/html');
    
    const eventData = {};
    const rows = doc.querySelectorAll('table tr');
    
    rows.forEach(row => {
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) {
        const key = th.textContent.trim().replace(/:$/, ''); // Remove trailing colon
        eventData[key] = td.textContent.trim();
      }
    });
    
    // Extract Narratives (usually contained in specific span blocks)
    const eventNarrativeSpan = doc.evaluate("//span[contains(text(), 'Event Narrative')]/following-sibling::span", doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (eventNarrativeSpan) eventData['Event Narrative'] = eventNarrativeSpan.textContent.trim();

    const episodeNarrativeSpan = doc.evaluate("//span[contains(text(), 'Episode Narrative')]/following-sibling::span", doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (episodeNarrativeSpan) eventData['Episode Narrative'] = episodeNarrativeSpan.textContent.trim();

    // --- ADDED FOR TESTING ---
    console.log(`===== RAW SCRAPED API DATA FOR EVENT ${eventId} =====`);
    console.log(eventData);
    window.lastFetchedApiData = eventData; // Exposes it so you can type lastFetchedApiData in the console
    // -------------------------

    setStatus(`Successfully fetched API data for Event ${eventId}.`, false);
    return eventData;
  } catch (err) {
    console.warn('Failed to fetch NCEI Event Data:', err);
    setStatus(`Failed to fetch API data for Event ID ${eventId}.`, true);
    return null;
  }
}

function bindControls() {
  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  const resetButton = document.getElementById('resetViewBtn');
  const csvInput = document.getElementById('csvUpload');
  const datInput = document.getElementById('datUpload');
  const exportButton = document.getElementById('exportCorrections');
  const themeButton = document.getElementById('themeToggleBtn');
  const saveButton = document.getElementById('saveChanges');
  const clearButton = document.getElementById('clearSelection');
  const spcToggleButton = document.getElementById('spcToggle');
  const spcMultiCountyButton = document.getElementById('spcMultiCountyBtn');
  const datLayerToggleButton = document.getElementById('datLayerToggle');
  const nceiLayerToggleButton = document.getElementById('nceiLayerToggle');
  const yearStartInput = document.getElementById('yearStartInput');
  const yearEndInput = document.getElementById('yearEndInput');
  const singleYearBtn = document.getElementById('singleYearBtn');
  const yearRangeToggleBtn = document.getElementById('yearRangeToggleBtn');
  const yearEndMini = document.querySelector('.year-end-mini');
  const yearEndSlider = document.getElementById('yearEndSlider');
  const yearEndSliderWrap = document.querySelector('.year-end-slider');
  const yearStartSlider = document.getElementById('yearStartSlider');
  const countyLayerToggleButton = document.getElementById('countyLayerToggle');

  const syncYearRangeVisibility = () => {
    const showEndYear = yearRangeToggleBtn?.getAttribute('aria-expanded') === 'true';
    if (!showEndYear) {
      state.yearMax = state.yearMin;
      if (yearEndInput) yearEndInput.value = String(state.yearMax);
      if (yearEndSlider) yearEndSlider.value = String(state.yearMax);
      if (yearMaxInput) yearMaxInput.value = String(state.yearMax);
    }
    if (yearEndMini) yearEndMini.classList.toggle('hidden', !showEndYear);
    if (yearEndSliderWrap) yearEndSliderWrap.classList.toggle('hidden', !showEndYear);
    if (yearRangeToggleBtn) {
      yearRangeToggleBtn.textContent = showEndYear ? 'Range on' : 'Range';
      yearRangeToggleBtn.classList.toggle('active', showEndYear);
    }
  };

  const applyYearRangeState = (nextMin, nextMax, triggerRender = true) => {
    const showEndYear = yearRangeToggleBtn?.getAttribute('aria-expanded') === 'true';
    const minYear = Number(yearStartInput?.min || 1950);
    const maxYear = Number(yearStartInput?.max || 2026);
    const safeMin = Math.min(Math.max(nextMin, minYear), maxYear);
    const safeMax = Math.min(Math.max(nextMax, minYear), maxYear);

    if (showEndYear) {
      state.yearMin = Math.min(safeMin, safeMax);
      state.yearMax = Math.max(safeMin, safeMax);
    } else {
      state.yearMin = safeMin;
      state.yearMax = safeMin;
    }

    if (yearStartInput) yearStartInput.value = String(state.yearMin);
    if (yearEndInput) yearEndInput.value = String(state.yearMax);
    if (yearStartSlider) yearStartSlider.value = String(state.yearMin);
    if (yearEndSlider) yearEndSlider.value = String(state.yearMax);
    if (yearMinInput) yearMinInput.value = String(state.yearMin);
    if (yearMaxInput) yearMaxInput.value = String(state.yearMax);

    updateFilterReadouts();
    if (triggerRender) {
      renderFilteredData({ preserveMapView: true });
    }
  };

  if (spcToggleButton) {
    spcToggleButton.addEventListener('click', () => {
      state.spcLayerVisible = !state.spcLayerVisible;
      updateSpcControls();
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (countyLayerToggleButton) {
    countyLayerToggleButton.addEventListener('click', () => {
      state.countyLayerVisible = !state.countyLayerVisible;
      updateCountyLayerControlStates();

      if (state.countyLayer) {
        if (state.countyLayerVisible) {
          if (!state.map.hasLayer(state.countyLayer)) {
            state.countyLayer.addTo(state.map);
          }
        } else if (state.map.hasLayer(state.countyLayer)) {
          state.map.removeLayer(state.countyLayer);
        }
      }
    });
  }

  if (nceiLayerToggleButton) {
    nceiLayerToggleButton.addEventListener('click', () => {
      state.nceiLayerVisible = !state.nceiLayerVisible;
      updateLayerControlStates();
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (datLayerToggleButton) {
    datLayerToggleButton.addEventListener('click', () => {
      state.datLayerVisible = !state.datLayerVisible;
      updateLayerControlStates();
      renderDatLayer(state.noaaDatMatches);
    });
  }

  if (spcMultiCountyButton) {
    spcMultiCountyButton.addEventListener('click', () => {
      state.spcMultiCountyOnly = !state.spcMultiCountyOnly;
      updateSpcControls();
      renderFilteredData({ preserveMapView: true });
    });
  }

  ['nceiOpacity', 'spcOpacity', 'datOpacity'].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', (event) => {
      const value = Number(event.target.value);
      if (id === 'nceiOpacity') state.nceiOpacity = value;
      if (id === 'spcOpacity') state.spcOpacity = value;
      if (id === 'datOpacity') state.datOpacity = value;
      renderFilteredData({ preserveMapView: true });
      renderDatLayer(state.noaaDatMatches);
    });
  });

  if (yearMinInput && yearMaxInput) {
    yearMinInput.addEventListener('change', () => {
      const parsed = Number(yearMinInput.value);
      if (parsed > Number(yearMaxInput.value)) {
        yearMaxInput.value = parsed;
      }
      state.yearMin = parsed;
      updateFilterReadouts();
      renderFilteredData({ preserveMapView: true });
    });

    yearMaxInput.addEventListener('change', () => {
      const parsed = Number(yearMaxInput.value);
      if (parsed < Number(yearMinInput.value)) {
        yearMinInput.value = parsed;
      }
      state.yearMax = parsed;
      updateFilterReadouts();
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (yearStartInput && yearEndInput) {
    const syncYearInputs = () => {
      const showEndYear = yearRangeToggleBtn?.getAttribute('aria-expanded') === 'true';
      if (!showEndYear) {
        state.yearMax = state.yearMin;
      } else if (state.yearMin > state.yearMax) {
        state.yearMax = state.yearMin;
      } else if (state.yearMax < state.yearMin) {
        state.yearMin = state.yearMax;
      }
      yearStartInput.value = String(state.yearMin);
      yearEndInput.value = String(state.yearMax);
      if (yearStartSlider) yearStartSlider.value = String(state.yearMin);
      if (yearEndSlider) yearEndSlider.value = String(state.yearMax);
      if (yearMinInput) yearMinInput.value = String(state.yearMin);
      if (yearMaxInput) yearMaxInput.value = String(state.yearMax);
      updateFilterReadouts();
    };

    yearStartInput.addEventListener('change', () => {
      const value = Number(yearStartInput.value);
      const minYear = Number(yearStartInput.min || 1950);
      const maxYear = Number(yearStartInput.max || 2025);
      const nextValue = Math.min(Math.max(value, minYear), maxYear);
      const showEndYear = yearRangeToggleBtn?.getAttribute('aria-expanded') === 'true';
      state.yearMin = nextValue;
      if (showEndYear) {
        if (state.yearMin > state.yearMax) {
          state.yearMax = state.yearMin;
        }
      } else {
        state.yearMax = state.yearMin;
      }
      syncYearInputs();
      renderFilteredData({ preserveMapView: true });
    });

    yearEndInput.addEventListener('change', () => {
      const value = Number(yearEndInput.value);
      const minYear = Number(yearEndInput.min || 1950);
      const maxYear = Number(yearEndInput.max || 2025);
      const nextValue = Math.min(Math.max(value, minYear), maxYear);
      const showEndYear = yearRangeToggleBtn?.getAttribute('aria-expanded') === 'true';
      state.yearMax = nextValue;
      if (showEndYear) {
        if (state.yearMax < state.yearMin) {
          state.yearMin = state.yearMax;
        }
      } else {
        state.yearMin = state.yearMax;
      }
      syncYearInputs();
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (singleYearBtn) {
    singleYearBtn.addEventListener('click', () => {
      const current = Number(state.yearMin);
      state.yearMin = current;
      state.yearMax = current;
      if (yearStartInput) yearStartInput.value = String(current);
      if (yearEndInput) yearEndInput.value = String(current);
      if (yearStartSlider) yearStartSlider.value = String(current);
      if (yearEndSlider) yearEndSlider.value = String(current);
      if (yearMinInput) yearMinInput.value = String(current);
      if (yearMaxInput) yearMaxInput.value = String(current);
      yearRangeToggleBtn?.setAttribute('aria-expanded', 'false');
      syncYearRangeVisibility();
      updateFilterReadouts();
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (yearRangeToggleBtn) {
    yearRangeToggleBtn.addEventListener('click', () => {
      const expanded = yearRangeToggleBtn.getAttribute('aria-expanded') === 'true';
      yearRangeToggleBtn.setAttribute('aria-expanded', String(!expanded));
      syncYearRangeVisibility();
      if (!yearRangeToggleBtn.getAttribute('aria-expanded') || yearRangeToggleBtn.getAttribute('aria-expanded') === 'false') {
        state.yearMax = state.yearMin;
        if (yearEndInput) yearEndInput.value = String(state.yearMax);
        if (yearEndSlider) yearEndSlider.value = String(state.yearMax);
        if (yearMaxInput) yearMaxInput.value = String(state.yearMax);
        updateFilterReadouts();
      }
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (yearStartSlider) {
    yearStartSlider.addEventListener('input', (event) => {
      const value = Number(event.target.value);
      const showEndYear = yearRangeToggleBtn?.getAttribute('aria-expanded') === 'true';
      applyYearRangeState(showEndYear ? value : value, showEndYear ? state.yearMax : value, true);
      syncYearRangeVisibility();
    });
  }

  if (yearEndSlider) {
    yearEndSlider.addEventListener('input', (event) => {
      const value = Number(event.target.value);
      const showEndYear = yearRangeToggleBtn?.getAttribute('aria-expanded') === 'true';
      if (!showEndYear) {
        applyYearRangeState(value, value, true);
      } else {
        applyYearRangeState(state.yearMin, value, true);
      }
      syncYearRangeVisibility();
    });
  }

  if (clearButton) {
    clearButton.addEventListener('click', () => {
      hideDetailsPanel();
      state.selectedId = null;
      
      // Reset all track styles to normal
      if (state.polyLines) {
        state.polyLines.forEach((layer) => {
          if (layer.setStyle) layer.setStyle({ weight: 3, opacity: 0.8 });
        });
      }
      
      clearDatLayer(true);
      clearRadarLayer(true);
      
      renderEditor();
      setStatus('Selection cleared.');
    });
  }

  ['datPolyToggle', 'datPathToggle', 'datPointToggle'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => {
        if (id === 'datPolyToggle') state.datPolygonsVisible = !state.datPolygonsVisible;
        if (id === 'datPathToggle') state.datPathsVisible = !state.datPathsVisible;
        if (id === 'datPointToggle') state.datPointsVisible = !state.datPointsVisible;
        
        btn.classList.toggle('active', 
          (id === 'datPolyToggle' && state.datPolygonsVisible) ||
          (id === 'datPathToggle' && state.datPathsVisible) ||
          (id === 'datPointToggle' && state.datPointsVisible)
        );

        renderDatLayer(state.noaaDatMatches);
      });
    }
  });
  // Button toggles
  ['radarReflectivityBtn', 'radarVelocityBtn', 'radarOffBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => {
        if (id === 'radarOffBtn') {
          const wasOn = state.radarType !== 'off';
          state.radarType = wasOn ? 'off' : 'reflectivity';
        }
        if (id === 'radarReflectivityBtn') {
          state.radarType = 'reflectivity';
        }
        if (id === 'radarVelocityBtn') {
          state.radarType = 'velocity';
        }
        
        const radarOn = state.radarType !== 'off';
        document.getElementById('radarOffBtn')?.classList.toggle('active', radarOn);
        document.getElementById('radarOffBtn')?.setAttribute('aria-label', radarOn ? 'Turn radar off' : 'Turn radar on');
        document.getElementById('radarOffBtn')?.setAttribute('title', radarOn ? 'Turn radar off' : 'Turn radar on');
        document.getElementById('radarOffBtn').textContent = radarOn ? 'On' : 'Off';
        document.getElementById('radarReflectivityBtn')?.classList.toggle('active', state.radarType === 'reflectivity');
        document.getElementById('radarVelocityBtn')?.classList.toggle('active', state.radarType === 'velocity');

        updateIemRadar();
      });
    }
  });

  // Time scrubber and step buttons
  const radarSlider = document.getElementById('radarTimeSlider');
  const stepBackBtn = document.getElementById('radarStepBackBtn');
  const stepFwdBtn = document.getElementById('radarStepFwdBtn');
  const radarOpacityInput = document.getElementById('radarOpacity');

  if (radarOpacityInput) {
    radarOpacityInput.addEventListener('input', (event) => {
      state.radarOpacity = Number(event.target.value);
      if (state.radarLayer) {
        state.radarLayer.setOpacity(state.radarOpacity);
      }
    });
  }

  if (radarSlider) {
    radarSlider.addEventListener('input', (e) => {
      state.radarScanIndex = parseInt(e.target.value, 10);
      updateIemRadar();
    });
  }

  if (stepBackBtn) {
    stepBackBtn.addEventListener('click', () => {
      if (state.radarScans && state.radarScanIndex > 0) {
        state.radarScanIndex--;
        if (radarSlider) radarSlider.value = state.radarScanIndex;
        updateIemRadar();
      }
    });
  }

  if (stepFwdBtn) {
    stepFwdBtn.addEventListener('click', () => {
      if (state.radarScans && state.radarScanIndex < state.radarScans.length - 1) {
        state.radarScanIndex++;
        if (radarSlider) radarSlider.value = state.radarScanIndex;
        updateIemRadar();
      }
    });
  }

  // Keyboard Left / Right arrow navigation
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const scrubber = document.getElementById('radarTimeScrubber');
    if (!scrubber || scrubber.classList.contains('hidden') || state.radarType === 'off') return;

    if (e.key === 'ArrowLeft' && state.radarScans && state.radarScanIndex > 0) {
      e.preventDefault();
      state.radarScanIndex--;
      if (radarSlider) radarSlider.value = state.radarScanIndex;
      updateIemRadar();
    } else if (e.key === 'ArrowRight' && state.radarScans && state.radarScanIndex < state.radarScans.length - 1) {
      e.preventDefault();
      state.radarScanIndex++;
      if (radarSlider) radarSlider.value = state.radarScanIndex;
      updateIemRadar();
    }
  });

  const zoomToTrackBtn = document.getElementById('zoomToTrackBtn');
  if (zoomToTrackBtn) {
    zoomToTrackBtn.addEventListener('click', () => {
      const record = getSelectedRecord();
      if (!record) {
        setStatus('Select a tornado segment before zooming.', true);
        return;
      }
      zoomToSelectedTrack();
    });
  }

  if (csvInput) {
    csvInput.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        return;
      }

      try {
        const text = await file.text();
        const parsed = Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (header) => String(header).trim(),
        });
        const rows = parsed.data
          .map((row) => normalizeRow(row, 'CSV'))
          .filter(Boolean);

        if (!rows.length) {
          throw new Error('No valid tornado rows found in the uploaded CSV.');
        }

        state.rows = rows;
        state.selectedId = null;
        setStatus(`Loaded ${rows.length.toLocaleString()} rows from ${file.name}.`);
        refreshYearBounds();
        renderFilteredData();
        renderEditor();
      } catch (error) {
        console.error(error);
        setStatus(error.message || 'Unable to parse uploaded CSV.', true);
      } finally {
        event.target.value = '';
      }
    });
  }

  if (datInput) {
    datInput.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        return;
      }

      try {
        const text = await file.text();
        const rows = parseDatRecords(text);
        if (!rows.length) {
          throw new Error('No usable records found in the DAT file.');
        }

        state.rows.push(...rows);
        state.selectedId = null;
        setStatus(`Imported ${rows.length.toLocaleString()} records from ${file.name}.`);
        refreshYearBounds();
        renderFilteredData();
        renderEditor();
      } catch (error) {
        console.error(error);
        setStatus(error.message || 'Unable to parse DAT file.', true);
      } finally {
        event.target.value = '';
      }
    });
  }

  // 2. Updated Export Logic with Exact UGC Formatting and Full Schema
  if (exportButton) {
    exportButton.addEventListener('click', async () => { 
      if (!state.corrections.size) {
        setStatus('No corrections to export yet.', true);
        return;
      }

      const stateFipsMap = {
        '01':'AL', '02':'AK', '04':'AZ', '05':'AR', '06':'CA', '08':'CO', '09':'CT', '10':'DE',
        '11':'DC', '12':'FL', '13':'GA', '15':'HI', '16':'ID', '17':'IL', '18':'IN', '19':'IA',
        '20':'KS', '21':'KY', '22':'LA', '23':'ME', '24':'MD', '25':'MA', '26':'MI', '27':'MN',
        '28':'MS', '29':'MO', '30':'MT', '31':'NE', '32':'NV', '33':'NH', '34':'NJ', '35':'NM',
        '36':'NY', '37':'NC', '38':'ND', '39':'OH', '40':'OK', '41':'OR', '42':'PA', '44':'RI',
        '45':'SC', '46':'SD', '47':'TN', '48':'TX', '49':'UT', '50':'VT', '51':'VA', '53':'WA',
        '54':'WV', '55':'WI', '56':'WY', '60':'AS', '66':'GU', '69':'MP', '72':'PR', '78':'VI'
      };

      const isPointInGeoJSON = (lon, lat, geometry) => {
        if (!geometry) return false;
        const checkPoly = (rings) => {
          let inPoly = false;
          for (let i = 0; i < rings.length; i++) {
            let inRing = false;
            const ring = rings[i];
            for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) {
              const xi = ring[j][0], yi = ring[j][1];
              const xj = ring[k][0], yj = ring[k][1];
              const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
              if (intersect) inRing = !inRing;
            }
            if (i === 0) inPoly = inRing; 
            else if (inRing) inPoly = false; 
          }
          return inPoly;
        };
        if (geometry.type === 'Polygon') return checkPoly(geometry.coordinates);
        if (geometry.type === 'MultiPolygon') {
          for (const poly of geometry.coordinates) {
            if (checkPoly(poly)) return true;
          }
        }
        return false;
      };

      // Helper to calculate original offsets for UTC to Local time conversions
      const parseSpcTimestamp = (ts) => {
        if (!ts || String(ts).trim() === 'nan') return null;
        const match = String(ts).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
        if (!match) return null;
        return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]));
      };

      const formatLocalDate = (d) => {
        if (isNaN(d) || !d) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
      };
      
      const formatLocalTime = (d) => {
        if (isNaN(d) || !d) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
      };

      setStatus(`Fetching NCEI data for ${state.corrections.size} reports... This may take a moment.`);
      
      const rows = [];
      for (const entry of Array.from(state.corrections.values())) {
        const originalRecord = state.rows.find(r => r.reportId === entry.originalReportId || r.id === entry.originalReportId) || {};
        const raw = originalRecord._raw || {};
        
        let apiData = {};
        if (entry.reportId) {
          const fetched = await fetchStormEventDetails(entry.reportId);
          if (fetched) apiData = fetched;
        }

        const lat = entry.beginLatitude;
        const lon = entry.beginLongitude;
        
        let countyProps = {};
        let wfoProps = {};
        
        // Spatial Lookup using Shapefiles
        if (lat !== undefined && lon !== undefined) {
          if (state.countyGeoJSON) {
            const cFeatures = Array.isArray(state.countyGeoJSON) ? state.countyGeoJSON[0].features : state.countyGeoJSON.features;
            for (const feature of cFeatures) {
              if (isPointInGeoJSON(lon, lat, feature.geometry)) {
                countyProps = feature.properties;
                break;
              }
            }
          }
          if (state.wfoGeoJSON) {
            const wFeatures = Array.isArray(state.wfoGeoJSON) ? state.wfoGeoJSON[0].features : state.wfoGeoJSON.features;
            for (const feature of wFeatures) {
              if (isPointInGeoJSON(lon, lat, feature.geometry)) {
                wfoProps = feature.properties;
                break;
              }
            }
          }
        }

        // Handle Time Conversions to Local Time
        const origUtcDate = parseSpcTimestamp(raw['beginTimestamp']);
        const origLocalDate = parseSpcTimestamp(raw['beginTimestampLocal']);
        const offsetMs = (origLocalDate && origUtcDate) ? (origLocalDate.getTime() - origUtcDate.getTime()) : 0;

        const newBeginUtc = new Date(`${entry.beginDate}T${entry.beginTime}:00Z`);
        const newEndUtc = new Date(`${entry.endDate}T${entry.endTime}:00Z`);

        const newBeginLocal = new Date(newBeginUtc.getTime() + offsetMs);
        const newEndLocal = new Date(newEndUtc.getTime() + offsetMs);

        const beginDateStr = formatLocalDate(newBeginLocal);
        const endDateStr = formatLocalDate(newEndLocal);
        const beginTimeStr = formatLocalTime(newBeginLocal);
        const endTimeStr = formatLocalTime(newEndLocal);
        
        // Build Narratives from requested columns
        let eventNarr = raw['overview'] || apiData['Event Narrative'] || '';
        if (entry.qcNotes) {
          eventNarr = `[QC NOTE: ${entry.qcNotes}] ${eventNarr}`.trim();
        }
        let epNarr = raw['details'] || apiData['Episode Narrative'] || '';
        let eventSrc = raw['source'] || apiData['Event Source'] || '';
        let epId = raw['stormEventsEpisodeID'] || apiData['Episode ID'] || '';

        // Generate FIPS and UGC Strings dynamically
        const stateAbbr = countyProps.STATEFP ? stateFipsMap[countyProps.STATEFP] : (apiData['State'] || raw['State'] || '');
        const countyFips3 = countyProps.COUNTYFP ? countyProps.COUNTYFP : (raw['County FIPS'] ? String(raw['County FIPS']).slice(-3) : '');
        
        const ugcString = (stateAbbr && countyFips3) 
            ? `${stateAbbr}-C${countyFips3}.1` 
            : (apiData['UGC Location ID'] || raw['UGC Location ID'] || '');
            
        let mag = entry.magnitude !== undefined ? entry.magnitude : (apiData['Magnitude'] || raw['Magnitude'] || '');
        mag = String(mag).replace(/EF/i, '').trim();

        // Construct the row prioritizing: QC Input -> API -> Original CSV
        const rowData = {
          'Event Type': apiData['Event Type'] || raw['Event Type'] || 'Tornado',
          'WFO': wfoProps.WFO || apiData['WFO'] || raw['WFO'] || '',
          'Year': beginDateStr ? beginDateStr.split('/')[2] : (apiData['Year'] || raw['Year'] || ''),
          'Month': beginDateStr ? beginDateStr.split('/')[0] : (apiData['Month'] || raw['Month'] || ''),
          'Begin Date/Time': beginDateStr && beginTimeStr ? `${beginDateStr} ${beginTimeStr}` : (apiData['Begin Date/Time'] || raw['Begin Date/Time'] || ''),
          'End Date/Time': endDateStr && endTimeStr ? `${endDateStr} ${endTimeStr}` : (apiData['End Date/Time'] || raw['End Date/Time'] || ''),
          'Begin Date': beginDateStr || apiData['Begin Date'] || raw['Begin Date'] || '',
          'End Date': endDateStr || apiData['End Date'] || raw['End Date'] || '',
          'Begin Time': beginTimeStr || apiData['Begin Time'] || raw['Begin Time'] || '',
          'End Time': endTimeStr || apiData['End Time'] || raw['End Time'] || '',
          'Timezone': apiData['Time Zone'] || apiData['Timezone'] || raw['Timezone'] || '', // <-- Updated this line
          'UGC Location ID': ugcString,
          'State': stateAbbr ? stateAbbr.toUpperCase() : '',
          'County FIPS': countyFips3, // Extracted 3-digit only
          'County Name': String(countyProps.NAME || apiData['County Name'] || raw['county'] || raw['County Name'] || '').toUpperCase(),
          'Region': wfoProps.REGION || apiData['Region'] || raw['Region'] || '',
          'Direct Injuries': entry.injuries !== undefined ? entry.injuries : (apiData['Direct Injuries'] || raw['Direct Injuries'] || 0),
          'Indirect Injuries': apiData['Indirect Injuries'] || raw['Indirect Injuries'] || 0,
          'Direct Fatalities': entry.deaths !== undefined ? entry.deaths : (apiData['Direct Fatalities'] || raw['Direct Fatalities'] || 0),
          'Indirect Fatalities': apiData['Indirect Fatalities'] || raw['Indirect Fatalities'] || 0,
          'Property Damage': apiData['Property Damage'] || raw['Property Damage'] || '',
          'Crop Damage': apiData['Crop Damage'] || raw['Crop Damage'] || '',
          'Criteria Met Date/Time': apiData['Criteria Met Date/Time'] || raw['Criteria Met Date/Time'] || '',
          'Magnitude': mag,
          'Magnitude Type': apiData['Magnitude Type'] || raw['Magnitude Type'] || '',
          'Flood Cause': apiData['Flood Cause'] || raw['Flood Cause'] || '',
          'Hurricane Category': apiData['Hurricane Category'] || raw['Hurricane Category'] || '',
          'Tornado F-Scale': (entry.magnitude !== undefined && entry.magnitude !== 'EFU') ? `EF${entry.magnitude}` : (apiData['Tornado F-Scale'] || raw['Tornado F-Scale'] || ''),
          'Tornado Length (miles)': entry.lengthMiles !== undefined ? entry.lengthMiles : (apiData['Tornado Length (miles)'] || raw['Tornado Length (miles)'] || ''),
          'Tornado Width (yards)': entry.widthYards !== undefined ? entry.widthYards : (apiData['Tornado Width (yards)'] || raw['Tornado Width (yards)'] || ''),
          'Tornado Continued in WFO': apiData['Tornado Continued in WFO'] || raw['Tornado Continued in WFO'] || '',
          'Tornado Continued in UGC': apiData['Tornado Continued in UGC'] || raw['Tornado Continued in UGC'] || '',
          'Event Source': eventSrc,
          'Event Narrative': eventNarr,
          'Episode Narrative': epNarr,
          'Event ID': entry.reportId || apiData['Event ID'] || raw['Event ID'] || '',
          'Episode ID': epId
        };

        // Construct dynamic Location columns (forced to UPPERCASE)
        for (let i = 1; i <= 8; i++) {
          const locStr = `Location #${i} (City/Range/Azimuth)`;
          const latStr = `Location #${i} (Lat)`;
          const lonStr = `Location #${i} (Lon)`;
          
          let locVal = apiData[locStr] || raw[locStr] || '';
          rowData[locStr] = String(locVal).toUpperCase();
          
          if (i === 1) {
            rowData[latStr] = entry.beginLatitude !== undefined ? entry.beginLatitude : (apiData[latStr] || raw[latStr] || '');
            rowData[lonStr] = entry.beginLongitude !== undefined ? entry.beginLongitude : (apiData[lonStr] || raw[lonStr] || '');
          } else if (i === 2) {
            rowData[latStr] = entry.endLatitude !== undefined ? entry.endLatitude : (apiData[latStr] || raw[latStr] || '');
            rowData[lonStr] = entry.endLongitude !== undefined ? entry.endLongitude : (apiData[lonStr] || raw[lonStr] || '');
          } else {
            rowData[latStr] = apiData[latStr] || raw[latStr] || '';
            rowData[lonStr] = apiData[lonStr] || raw[lonStr] || '';
          }
        }
        
        rows.push(rowData);
      } // End of async for-loop

      const csv = toCsv(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'events_formatted.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${rows.length} fully formatted NCEI event row(s).`);
    });
  }

  const exportOriginalButton = document.getElementById('exportOriginalCorrections');

  if (exportOriginalButton) {
    exportOriginalButton.addEventListener('click', () => {
      if (!state.corrections.size) {
        setStatus('No corrections to export yet.', true);
        return;
      }

      const parseSpcTimestamp = (ts) => {
        if (!ts || String(ts).trim() === 'nan') return null;
        const match = String(ts).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
        if (!match) return null;
        return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]));
      };

      const formatSpcTimestamp = (date) => {
        if (!date || isNaN(date)) return 'nan';
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
      };

      const rows = Array.from(state.corrections.values()).map((entry) => {
        const originalRecord = state.rows.find(r => r.reportId === entry.originalReportId || r.id === entry.originalReportId) || {};
        const raw = originalRecord._raw ? { ...originalRecord._raw } : {};
        
        const changes = [];
        const timeFields = ['beginTime', 'endTime']; // Strictly 4-digit fields
        
        const updateField = (rawKey, newValue) => {
          if (newValue === undefined || newValue === null) return;
          
          const oldVal = raw[rawKey];
          let oldStr = String(oldVal ?? 'nan').trim();
          let newStr = String(newValue).trim();

          if (['beginLatitude', 'beginLongitude', 'endLatitude', 'endLongitude'].includes(rawKey)) {
            if (oldStr === '' || Number(oldStr) === 0 || Math.abs(Number(oldStr)) >= 99900) {
              oldStr = 'nan';
            }
          }

          // Force 4-digit padding only for true HHMM fields
          if (timeFields.includes(rawKey)) {
            if (oldStr !== 'nan') oldStr = oldStr.padStart(4, '0');
            newStr = newStr.padStart(4, '0');
            newValue = newStr; 
          }

          const isNumeric = oldStr !== 'nan' && newStr !== 'nan' && !isNaN(oldStr) && !isNaN(newStr) && oldStr !== '' && newStr !== '';
          const isNumericallyEqual = isNumeric && (Number(oldStr) === Number(newStr));

          if (!isNumericallyEqual && oldStr !== newStr) {
            changes.push(`${rawKey}: ${oldStr} --> ${newStr}`);
            raw[rawKey] = newValue;
          } else if (timeFields.includes(rawKey)) {
            raw[rawKey] = newValue;
          }
        };

        updateField('beginLatitude', entry.beginLatitude);
        updateField('beginLongitude', entry.beginLongitude);
        updateField('endLatitude', entry.endLatitude);
        updateField('endLongitude', entry.endLongitude);
        updateField('tornadoLength', entry.lengthMiles);
        updateField('tornadoWidth', entry.widthYards);
        updateField('magnitude', entry.magnitude);
        
        const origUtcDate = parseSpcTimestamp(raw['beginTimestamp']);
        const origLocalDate = parseSpcTimestamp(raw['beginTimestampLocal']);
        const offsetMs = (origLocalDate && origUtcDate) ? (origLocalDate.getTime() - origUtcDate.getTime()) : 0;

        const newBeginUtc = new Date(`${entry.beginDate}T${entry.beginTime}:00Z`);
        const newEndUtc = new Date(`${entry.endDate}T${entry.endTime}:00Z`);
        const pad = (n) => String(n).padStart(2, '0');

        // Capture original timestamps for correct multi-segment sync
        const origBeginTimestamp = String(originalRecord._raw['beginTimestamp'] ?? 'nan').trim();
        const origEndTimestamp = String(originalRecord._raw['endTimestamp'] ?? 'nan').trim();
        const origTornadoBeginTime = String(originalRecord._raw['tornadoBeginTime'] ?? 'nan').trim();
        const origTornadoEndTime = String(originalRecord._raw['tornadoEndTime'] ?? 'nan').trim();

        if (!isNaN(newBeginUtc)) {
          const newTimeStr = `${pad(newBeginUtc.getUTCHours())}${pad(newBeginUtc.getUTCMinutes())}`;
          const newTimestamp = formatSpcTimestamp(newBeginUtc);
          
          updateField('beginTimestamp', newTimestamp);
          updateField('beginTimestampLocal', formatSpcTimestamp(new Date(newBeginUtc.getTime() + offsetMs)));
          updateField('beginUnix', Math.floor(newBeginUtc.getTime() / 1000));
          updateField('beginYear', newBeginUtc.getUTCFullYear());
          updateField('beginMonth', newBeginUtc.getUTCMonth() + 1);
          updateField('beginDay', newBeginUtc.getUTCDate());
          updateField('beginTime', newTimeStr);
          
          // Sync tornadoBeginTime if it originally matched the segment beginTimestamp
          if (origTornadoBeginTime !== 'nan' && origTornadoBeginTime === origBeginTimestamp) {
            updateField('tornadoBeginTime', newTimestamp); 
          }
        }

        if (!isNaN(newEndUtc)) {
          const newTimeStr = `${pad(newEndUtc.getUTCHours())}${pad(newEndUtc.getUTCMinutes())}`;
          const newTimestamp = formatSpcTimestamp(newEndUtc);
          
          updateField('endTimestamp', newTimestamp);
          updateField('endTimestampLocal', formatSpcTimestamp(new Date(newEndUtc.getTime() + offsetMs)));
          updateField('endUnix', Math.floor(newEndUtc.getTime() / 1000));
          updateField('endYear', newEndUtc.getUTCFullYear());
          updateField('endMonth', newEndUtc.getUTCMonth() + 1);
          updateField('endDay', newEndUtc.getUTCDate());
          updateField('endTime', newTimeStr);
          
          // Sync tornadoEndTime if it originally matched the segment endTimestamp
          if (origTornadoEndTime !== 'nan' && origTornadoEndTime === origEndTimestamp) {
            updateField('tornadoEndTime', newTimestamp);
          }
        }

        // Segment Duration
        if (!isNaN(newBeginUtc) && !isNaN(newEndUtc)) {
          const durationMinutes = Math.round((newEndUtc.getTime() - newBeginUtc.getTime()) / 60000);
          updateField('durationMin', durationMinutes);
        }

        // Recalculate totalDurationMin based strictly on the updated tornado times
        const currentTorBeginStr = String(raw['tornadoBeginTime'] ?? 'nan').trim();
        const currentTorEndStr = String(raw['tornadoEndTime'] ?? 'nan').trim();
        
        if (currentTorBeginStr !== 'nan' && currentTorEndStr !== 'nan') {
            const torBeginDate = parseSpcTimestamp(currentTorBeginStr);
            const torEndDate = parseSpcTimestamp(currentTorEndStr);
            if (torBeginDate && torEndDate) {
                const totalDiff = Math.round((torEndDate.getTime() - torBeginDate.getTime()) / 60000);
                updateField('totalDurationMin', totalDiff);
            }
        }

        const isValidNote = (note) => {
          if (note === null || note === undefined) return false;
          const str = String(note).trim().toLowerCase();
          return str !== '' && str !== 'nan' && str !== '-99900' && str !== '-99900.0' && str !== '0' && str !== '0.0';
        };

        if (changes.length > 0) {
          const changeString = `Changes from QC: ${changes.join('; ')}`;
          const existingAuto = isValidNote(raw['autoQCnotes']) ? `${raw['autoQCnotes']} | ` : '';
          raw['autoQCnotes'] = `${existingAuto}${changeString}`;
        }
        
        if (entry.qcNotes) {
          const existingManual = isValidNote(raw['QCnotes']) ? `${raw['QCnotes']} | ` : '';
          raw['QCnotes'] = `${existingManual}${entry.qcNotes}`;
        }
        
        if (changes.length > 0 || entry.qcNotes) {
          raw['QCd'] = 1;
          raw['corrected'] = 1;
        }

        const ensurePaddedTime = (key) => {
          if (raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim() !== 'nan') {
            raw[key] = String(raw[key]).trim().padStart(4, '0');
          }
        };

        const ensurePaddedDatePart = (key) => {
          if (raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim() !== 'nan') {
            raw[key] = String(raw[key]).trim().padStart(2, '0');
          }
        };

        ensurePaddedTime('beginTime');
        ensurePaddedTime('endTime');
        
        ensurePaddedDatePart('beginMonth');
        ensurePaddedDatePart('beginDay');
        ensurePaddedDatePart('endMonth');
        ensurePaddedDatePart('endDay');

        return raw;
      });

      const csv = toCsv(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'tornado_qc_corrections_original_format.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${rows.length} row(s) in Original CSV format.`);
    });
  }

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      const nextMode = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(nextMode);
      setStatus(`Switched to ${nextMode} mode.`);
    });
  }

  if (saveButton) {
    saveButton.addEventListener('click', () => {
      const record = getSelectedRecord();
      if (!record) {
        setStatus('Select a tornado segment before saving edits.', true);
        return;
      }

      const payload = {
        reportId: document.getElementById('reportId').value.trim() || record.reportId,
        beginDate: document.getElementById('beginDate').value,
        beginTime: document.getElementById('beginTime').value,
        endDate: document.getElementById('endDate').value,
        endTime: document.getElementById('endTime').value,
        beginLatitude: Number(document.getElementById('beginLat').value),
        beginLongitude: Number(document.getElementById('beginLon').value),
        endLatitude: Number(document.getElementById('endLat').value),
        endLongitude: Number(document.getElementById('endLon').value),
        lengthMiles: Number(document.getElementById('pathLength').value),
        widthYards: Number(document.getElementById('pathWidth').value),
        qcNotes: document.getElementById('qcNotes').value.trim(),
      };

      const original = { ...record };
      const updated = {
        ...record,
        reportId: payload.reportId,
        beginDate: payload.beginDate,
        beginTime: payload.beginTime,
        endDate: payload.endDate,
        endTime: payload.endTime,
        beginLatitude: payload.beginLatitude,
        beginLongitude: payload.beginLongitude,
        endLatitude: payload.endLatitude,
        endLongitude: payload.endLongitude,
        lengthMiles: payload.lengthMiles,
        widthYards: payload.widthYards,
        qcNotes: payload.qcNotes,
      };

      Object.assign(record, updated);
      state.corrections.set(record.id || record.reportId, {
        source: record.source,
        reportId: record.reportId,
        originalReportId: original.reportId,
        beginDate: payload.beginDate,
        beginTime: payload.beginTime,
        endDate: payload.endDate,
        endTime: payload.endTime,
        beginLatitude: payload.beginLatitude,
        beginLongitude: payload.beginLongitude,
        endLatitude: payload.endLatitude,
        endLongitude: payload.endLongitude,
        lengthMiles: payload.lengthMiles,
        widthYards: payload.widthYards,
        magnitude: record.magnitude,
        qcNotes: payload.qcNotes,
      });

      updateExportButtonLabel();
      renderFilteredData({ preserveMapView: true });
      renderEditor();
      setStatus(`Saved updates for ${record.reportId || record.id}.`);
    });
  }

  if (clearButton) {
    clearButton.addEventListener('click', () => {
      state.selectedId = null;
      
      // Reset all track styles to normal
      if (state.polyLines) {
        state.polyLines.forEach((layer) => {
          if (layer.setStyle) layer.setStyle({ weight: 3, opacity: 0.8 });
        });
      }
      
      clearDatLayer(true);
      clearRadarLayer(true);
      
      renderEditor();
      setStatus('Selection cleared.');
    });
  }

  const radarOffBtn = document.getElementById('radarOffBtn');
  const radarReflectivityBtn = document.getElementById('radarReflectivityBtn');
  const radarVelocityBtn = document.getElementById('radarVelocityBtn');

  if (radarOffBtn) {
    const radarOn = state.radarType !== 'off';
    radarOffBtn.textContent = radarOn ? 'On' : 'Off';
    radarOffBtn.classList.toggle('active', radarOn);
    radarOffBtn.setAttribute('aria-label', radarOn ? 'Turn radar off' : 'Turn radar on');
    radarOffBtn.title = radarOn ? 'Turn radar off' : 'Turn radar on';
  }

  if (radarReflectivityBtn) {
    radarReflectivityBtn.classList.toggle('active', state.radarType === 'reflectivity');
  }

  if (radarVelocityBtn) {
    radarVelocityBtn.classList.toggle('active', state.radarType === 'velocity');
  }

  const pathIdLookupInput = document.getElementById('pathIdLookup');
  const pathIdLookupBtn = document.getElementById('pathIdLookupBtn');

  if (pathIdLookupBtn && pathIdLookupInput) {
    const runPathIdLookup = () => {
      const raw = (pathIdLookupInput.value || '').trim();
      if (!raw) {
        setStatus('Enter an NCEI path ID to search.', true);
        return;
      }

      const needle = String(raw).trim().toLowerCase();
      const match = state.rows.find((row) => {
        const candidates = [
          row.reportId,
          row.id,
          row.stormEventsReportID,
          row.StormEventsReportID,
          row.report_id,
          row.REPORT_ID,
          row.event_id,
          row.EVENT_ID,
        ];
        return candidates.some((value) => value != null && String(value).trim().toLowerCase() === needle);
      });

      if (!match) {
        setStatus(`No NCEI path found for ID: ${raw}`, true);
        return;
      }

      const matchYear = Number(match.year || getYearFromDate(match.beginDate));
      if (matchYear && (matchYear < state.yearMin || matchYear > state.yearMax)) {
        state.yearMin = Math.min(state.yearMin, matchYear);
        state.yearMax = Math.max(state.yearMax, matchYear);
        
        // Update the underlying DOM inputs before calling updateFilterReadouts
        // so it doesn't overwrite our new state with the old HTML values
        const yearMinInput = document.getElementById('yearMin');
        const yearMaxInput = document.getElementById('yearMax');
        if (yearMinInput) yearMinInput.value = state.yearMin;
        if (yearMaxInput) yearMaxInput.value = state.yearMax;
        
        const rangeToggleBtn = document.getElementById('yearRangeToggleBtn');
        if (rangeToggleBtn && state.yearMin !== state.yearMax) {
          rangeToggleBtn.setAttribute('aria-expanded', 'true');
          rangeToggleBtn.textContent = 'Range on';
          document.querySelector('.year-end-mini')?.classList.remove('hidden');
          document.querySelector('.year-end-slider')?.classList.remove('hidden');
        }
        
        updateFilterReadouts();
        renderFilteredData({ preserveMapView: true });
      }

      state.selectedId = match.id;
      renderEditor();
      renderDetailsPanel(match);

      const matchPath = state.polyLines && state.polyLines.get(match.id);
      if (matchPath && state.map) {
        const latLngs = matchPath.getLatLngs ? matchPath.getLatLngs() : [];
        if (latLngs.length) {
          const bounds = L.latLngBounds(latLngs);
          if (bounds.isValid()) {
            state.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 12 });
          }
        }
      }

      if (state.polyLines) {
        state.polyLines.forEach((layer, id) => {
          if (layer.setStyle) {
            layer.setStyle({ weight: id === match.id ? 6 : 3, opacity: id === match.id ? 1 : 0.8 });
          }
        });
      }

      setStatus(`Selected NCEI path ${raw}.`, false);
      handleTrackSelection(match, false);
    };

    pathIdLookupBtn.addEventListener('click', runPathIdLookup);
    pathIdLookupInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runPathIdLookup();
      }
    });
  }
  // --- SYNC MANUAL TYPING TO MAP MARKERS ---
  const syncCoordinatesToMap = () => {
    const record = getSelectedRecord();
    if (!record || !state.editHandles.start || !state.editHandles.end) return;

    const sLat = Number(document.getElementById('beginLat').value) || record.beginLatitude;
    const sLon = Number(document.getElementById('beginLon').value) || record.beginLongitude;
    const eLat = Number(document.getElementById('endLat').value) || record.endLatitude;
    const eLon = Number(document.getElementById('endLon').value) || record.endLongitude;

    state.editHandles.start.setLatLng([sLat, sLon]);
    state.editHandles.end.setLatLng([eLat, eLon]);
    
    const path = state.polyLines.get(record.id);
    if (path) path.setLatLngs([[sLat, sLon], [eLat, eLon]]);

    updateLivePathLength();
  };

  ['beginLat', 'beginLon', 'endLat', 'endLon'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', syncCoordinatesToMap);
  });

// --- ADD TINY ACTION BUTTONS TO QC FIELDS ---
  const fieldMapping = {
    'reportId': 'reportId',
    'beginDate': 'beginDate',
    'beginTime': 'beginTime',
    'endDate': 'endDate',
    'endTime': 'endTime',
    'beginLat': 'beginLatitude',
    'beginLon': 'beginLongitude',
    'endLat': 'endLatitude',
    'endLon': 'endLongitude',
    'pathLength': 'lengthMiles',
    'pathWidth': 'widthYards',
    'qcNotes': 'qcNotes'
  };

  Object.keys(fieldMapping).forEach(inputId => {
    const input = document.getElementById(inputId);
    if (!input) return;
    
    const label = input.closest('label');
    if (label) {
      label.style.position = 'relative';
      
      // Container for the buttons
      const btnGroup = document.createElement('div');
      Object.assign(btnGroup.style, {
        position: 'absolute',
        right: '0',
        top: '-2px',
        display: 'flex',
        gap: '4px'
      });
      
      // Helper to generate identical tiny buttons
      const createTinyBtn = (icon, title, extraClass = '') => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `secondary ${extraClass}`.trim();
        btn.innerHTML = icon;
        btn.title = title;
        
        Object.assign(btn.style, {
          width: '16px',
          height: '16px',
          padding: '0',
          fontSize: '8px',
          lineHeight: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '4px',
          border: '1px solid var(--border)',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--muted)',
          transition: 'color 0.2s',
          verticalAlign: 'middle'
        });
        
        btn.onmouseover = () => btn.style.color = 'var(--text)';
        btn.onmouseout = () => btn.style.color = 'var(--muted)';
        
        return btn;
      };

      // 1. Copy Button
      const copyBtn = createTinyBtn('📑', 'Copy');
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(input.value);
          copyBtn.innerHTML = '✨';
          setTimeout(() => copyBtn.innerHTML = '📑', 1000);
        } catch (err) {
          console.error('Failed to copy', err);
        }
      });

      // 2. Paste Button
      const pasteBtn = createTinyBtn('📋', 'Paste');
      pasteBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          input.value = await navigator.clipboard.readText();
          // Dispatch events in case other listeners are tracking input changes
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (err) {
          console.error('Failed to paste', err);
        }
      });

      // 3. Reset Button (with your exact original logic)
      const resetBtn = createTinyBtn('↺', 'Reset to saved value', 'reset-field-btn');
      resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const record = getSelectedRecord();
        if (!record) return;
        
        if (['beginLat', 'beginLon'].includes(inputId)) {
          document.getElementById('beginLat').value = record.beginLatitude ?? '';
          document.getElementById('beginLon').value = record.beginLongitude ?? '';
          syncCoordinatesToMap();
        } else if (['endLat', 'endLon'].includes(inputId)) {
          document.getElementById('endLat').value = record.endLatitude ?? '';
          document.getElementById('endLon').value = record.endLongitude ?? '';
          syncCoordinatesToMap();
        } else {
          input.value = record[fieldMapping[inputId]] ?? '';
        }
      });

      // Append all buttons to the group, then the group to the label
      btnGroup.appendChild(copyBtn);
      btnGroup.appendChild(pasteBtn);
      btnGroup.appendChild(resetBtn);
      
      label.appendChild(btnGroup);
    }
  });
}

function updateDatLayerSectionVisibility() {
  const datLayerSection = document.getElementById('datLayerSection');
  if (!datLayerSection) return;

  const hasSelectedRecord = !!getSelectedRecord();
  const hasDatMatches = Array.isArray(state.noaaDatMatches) && state.noaaDatMatches.length > 0;
  datLayerSection.classList.toggle('hidden', !(hasSelectedRecord || hasDatMatches));
}

function toCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '';
  }

  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const escapeCell = (value) => {
    const text = value == null ? '' : String(value);
    return /[","]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCell(row[header])).join(','));
  }
  return lines.join('\n');
}

function renderFilteredData(options = {}) {
  const { preserveMapView = false } = options;
  
  const primaryRows = state.rows.filter((row) => {
    // Check for beginYear first, then fallback to year, then fallback to parsing the timestamps
    const rowYear = Number(row.beginYear || row.year || getYearFromDate(row.beginTimestamp || row.beginDate));
    return rowYear >= state.yearMin && rowYear <= state.yearMax;
  });

  let spcRows = [];
  if (state.spcLayerVisible) {
    spcRows = state.spcRows.filter((row) => {
      // Same fix here for the SPC data
      const rowYear = Number(row.beginYear || row.year || getYearFromDate(row.beginTimestamp || row.beginDate));
      const inRange = rowYear >= state.yearMin && rowYear <= state.yearMax;
      const multiCountyPass = !state.spcMultiCountyOnly || isMultiCountyRow(row);
      return inRange && multiCountyPass;
    });
  }

  const filtered = [
    ...(state.spcLayerVisible ? spcRows : []),
    ...(state.nceiLayerVisible ? primaryRows : []),
  ];
  
  if (state.layerGroup) {
    state.layerGroup.clearLayers();
    if (!state.map.hasLayer(state.layerGroup)) {
      state.layerGroup.addTo(state.map);
    }
  }

  if (state.editLayerGroup) {
    state.editLayerGroup.clearLayers();
  }

  if (!filtered.length) {
    const trackCount = document.getElementById('trackCount');
    const maxMagnitude = document.getElementById('maxMagnitude');
    const maxLength = document.getElementById('maxLength');
    if (trackCount) trackCount.textContent = '0';
    if (maxMagnitude) maxMagnitude.textContent = '0';
    if (maxLength) maxLength.textContent = '0 mi';
    setStatus('No tornado tracks match the selected filters.', false);
    return;
  }

  let bounds = L.latLngBounds([]);

  filtered.forEach((row) => {
    // 1. Parse coordinates safely
    const startLat = parseFloat(row.beginLatitude);
    const startLon = parseFloat(row.beginLongitude);
    const endLat = parseFloat(row.endLatitude);
    const endLon = parseFloat(row.endLongitude);

    // 2. Validate coordinates before trying to draw
    const hasStart = !isNaN(startLat) && !isNaN(startLon);
    const hasEnd = !isNaN(endLat) && !isNaN(endLon);

    // If we don't even have a valid start coordinate, skip this row entirely so it doesn't crash the map
    if (!hasStart) return; 

    const startPoint = [startLat, startLon];
    const endPoint = hasEnd ? [endLat, endLon] : null;

    const isSpc = row.source === 'SPC';
    const color = getUnifiedTrackColor(row.magnitude);
    const layerOpacity = isSpc ? state.spcOpacity : state.nceiOpacity;

    // --- DRAW POLYLINE (Only if we have an end point) ---
    if (hasEnd) {
      const polyline = L.polyline([startPoint, endPoint], {
        color,
        weight: row.id === state.selectedId ? 6 : 3,
        opacity: layerOpacity,
        lineCap: 'round',
        dashArray: isSpc ? '8 8' : null,
      });

      if (row.source !== 'CSV') {
        polyline.bindPopup(buildPopup(row));
      }
      polyline.on('click', async (event) => {
        L.DomEvent.stopPropagation(event);
        await handleTrackSelection(row, true);
      });
      polyline.addTo(state.layerGroup);
      state.polyLines.set(row.id, polyline);
    }

    // --- DRAW START MARKER ---
    const startIcon = L.divIcon({
      className: 'ncei-start-icon',
      html: `<div style="box-sizing: border-box; width: 8px; height: 8px; border-radius: 50%; border: 1px solid #f8fafc; background: ${color}; box-shadow: 0 1px 3px rgba(0,0,0,0.5); transform: scale(var(--marker-scale, 1)); transform-origin: center;"></div>`,      iconSize: [8, 8],
      iconAnchor: [4, 4]
    });
    const startMarker = L.marker(startPoint, {
      icon: startIcon,
      opacity: layerOpacity,
      zIndexOffset: 100
    });
    if (row.source !== 'CSV') {
      startMarker.bindPopup(buildPopup(row));
    }
    startMarker.on('click', async (event) => {
      L.DomEvent.stopPropagation(event);
      await handleTrackSelection(row, true);
    });
    startMarker.addTo(state.layerGroup);

    // --- DRAW END MARKER (Only if we have an end point) ---
    if (hasEnd) {
      const endIcon = L.divIcon({
        className: 'ncei-end-icon',
        html: `<div style="box-sizing: border-box; width: 8px; height: 8px; border: 1px solid #f8fafc; background: ${color}; box-shadow: 0 1px 2px rgba(0,0,0,0.4); transform: scale(var(--marker-scale, 1)); transform-origin: center;"></div>`,
        iconSize: [8, 8],
        iconAnchor: [4, 4]
      });
      
      const endMarker = L.marker(endPoint, {
        icon: endIcon,
        opacity: layerOpacity,
        zIndexOffset: 0
      });
      
      if (row.source !== 'CSV') endMarker.bindPopup(buildPopup(row));
      endMarker.on('click', async (event) => {
        L.DomEvent.stopPropagation(event);
        await handleTrackSelection(row, true);
      });
      endMarker.addTo(state.layerGroup);

      // Extend bounds to include both points
      bounds.extend([startPoint, endPoint]);
    } else {
      // Extend bounds for just the start point
      bounds.extend([startPoint]);
    }
  });

  const stats = calculateStats(filtered);
  const trackCount = document.getElementById('trackCount');
  const maxMagnitude = document.getElementById('maxMagnitude');
  const maxLength = document.getElementById('maxLength');
  if (trackCount) trackCount.textContent = stats.count.toLocaleString();
  if (maxMagnitude) maxMagnitude.textContent = String(stats.maxMagnitude);
  if (maxLength) maxLength.textContent = `${stats.maxLength.toFixed(0)} mi`;

  state.allBounds = bounds;
  if (bounds.isValid() && !preserveMapView) {
    state.map.fitBounds(bounds, { padding: [30, 30] });
  }

  renderEditor();
  setStatus(`Showing ${filtered.length.toLocaleString()} tornado tracks for ${state.yearMin} to ${state.yearMax}.`, false);
}

function isMultiCountyRow(row) {
  if (!row) return false;
  
  // In SPC data, f2/f3/f4 hold FIPS codes for the 2nd/3rd/4th counties.
  // If f2 > 0, it crossed a county line.
  const candidateValues = [
    row.f2, row.f_2, row.multiCounty, row.multi_county
  ];
  
  for (const value of candidateValues) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    
    const numeric = Number.parseFloat(String(value).replace(/,/g, '').trim());
    
    // If it's a valid number and it is NOT zero, it is a multi-county track.
    if (Number.isFinite(numeric) && numeric !== 0) {
      return true;
    }
  }
  return false;
}

function clearDatLayer(clearData = false) {
  if (state.datLayerGroup) {
    state.datLayerGroup.clearLayers();
  }
  if (clearData) {
    state.noaaDatMatches = [];
  }
  updateDatLayerSectionVisibility();
}

function clearRadarLayer(clearCache = false) {
  if (state.radarLayer && state.map) {
    state.map.removeLayer(state.radarLayer);
  }
  state.radarLayer = null;
  if (clearCache) {
    state.radarScans = [];
    state.radarScanIndex = 0;
    state.radarRecordId = null;
    state.radarRequestToken += 1;
  }

  const radarStatus = document.getElementById('radarStatus');
  if (radarStatus) radarStatus.textContent = '';
  const radarOffsetLabel = document.getElementById('radarOffsetLabel');
  if (radarOffsetLabel) radarOffsetLabel.textContent = '--:-- UTC';
}

function buildDatPopupHtml(attrs = {}, fallbackLabel = 'DAT', efValue = 'N/A', geomType = 'Unknown Geometry') {
  const values = attrs || {};
  const rows = [];

  const addRow = (label, ...candidates) => {
    const value = firstNonEmpty(...candidates);
    if (value === null || value === undefined) return;

    const text = typeof value === 'string' ? value.trim() : String(value);
    if (!text || text === 'null' || text === 'NaN') return;

    rows.push([label, text]);
  };

  const rawDate = firstNonEmpty(values.stormdate, values.EVENT_DATE, values.event_date, values.date);
  let stormDateFormatted = 'N/A';

  if (rawDate) {
    const numDate = Number(rawDate);
    if (!isNaN(numDate) && numDate > 10000000000) {
      const dt = new Date(numDate);
      if (!isNaN(dt.getTime())) {
        const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dt.getUTCDate()).padStart(2, '0');
        const yyyy = dt.getUTCFullYear();
        const hh = String(dt.getUTCHours()).padStart(2, '0');
        const min = String(dt.getUTCMinutes()).padStart(2, '0');
        stormDateFormatted = `${mm}/${dd}/${yyyy} ${hh}:${min} UTC`;
      }
    } else {
      const rawTime = firstNonEmpty(values.stormtime, values.EVENT_TIME, values.event_time, values.time);
      stormDateFormatted = rawTime ? `${rawDate} ${rawTime} UTC` : String(rawDate);
    }
  }

  // Check for length provided by DAT or the length we just calculated
  const lengthVal = firstNonEmpty(values.calculated_length, values.length, values.LENGTH, values.track_length, values.track_length_mi);

  addRow('Event ID', values.event_id, values.EVENT_ID, values.eventId, values.EVENTID, values.objectid, values.OBJECTID, fallbackLabel);
  addRow('Storm Date', stormDateFormatted);
  addRow('EF Rating', efValue);
  addRow('Path Length', lengthVal ? (String(lengthVal).includes('mi') ? lengthVal : `${Number(lengthVal).toFixed(2)} mi`) : null);
  addRow('Winds (MPH)', values.wind_speed, values.WIND_SPEED, values.wind, values.WIND);
  addRow('Damage Indicator', values.di, values.DI, values.damage_txt, values.DAMAGE_TXT, values.damage_indicator, values.DAMAGE_INDICATOR);
  addRow('Degree of Damage', values.dod, values.DOD, values.degree_of_damage);
  addRow('Damage Direction', values.direction, values.DIRECTION, values.damage_direction, values.damage_dir);
  addRow('Injuries', values.injuries, values.INJURIES, values.injury_count, values.num_injuries);
  addRow('Fatalities', values.fatalities, values.FATALITIES, values.deaths, values.DEATHS, values.num_fatalities);
  addRow('Comments', values.comments, values.COMMENTS, values.notes, values.NOTES);

  if (geomType === 'LineString' || geomType === 'MultiLineString') {
    geomType = 'Path';
  } else if (geomType === 'MultiPolygon' || geomType === 'Polygon') {
    geomType = 'Polygon';
  } else if (geomType === 'Point' || geomType === 'MultiPoint') {
    geomType = 'Point';
  }

  const uniqueRows = [];
  const seen = new Set();
  for (const [label, text] of rows) {
    const key = `${label}::${text}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRows.push([label, text]);
    }
  }

  const popupCells = uniqueRows.map(([label, text]) => {
    if (typeof text === 'string' && text.startsWith('http')) {
      return `<span>${escapeHtml(label)}</span><strong><a href="${escapeHtml(text)}" target="_blank" style="color: var(--accent);">View Link</a></strong>`;
    }
    return `<span>${escapeHtml(label)}</span><strong>${escapeHtml(text)}</strong>`;
  }).join('');

  const layerId = values._layerId;
  const objectId = values._objectId;
  const containerId = `dat-img-${layerId}-${objectId}`;
  
  const imageHtml = (layerId !== undefined && objectId !== undefined)
    ? `<div id="${containerId}" style="grid-column: 1 / -1;"></div>`
    : '';

  return `
    <div class="popup-title">NOAA DAT ${escapeHtml(geomType)}</div>
    <div class="popup-grid" style="max-height: 280px; overflow-y: auto; padding-right: 6px; overflow-x: hidden;">
      ${popupCells || '<span>Event</span><strong>DAT</strong>'}
      ${imageHtml}
    </div>
  `;
}

function getEfRank(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'EF5' || text === 'F5') return 5;
  if (text === 'EF4' || text === 'F4') return 4;
  if (text.startsWith('EF3') || text.startsWith('F3')) return 3; // Catch EF3+
  if (text === 'EF2' || text === 'F2') return 2;
  if (text === 'EF1' || text === 'F1') return 1;
  if (text === 'EF0' || text === 'F0') return 0;
  return -1; // Unrated, wind, or other types go to the very bottom
}

function renderDatLayer(features) {
  clearDatLayer(false);
  if (!features || !features.length || !state.datLayerGroup || !state.datLayerVisible) return;

  updateDatLayerSectionVisibility();

  // Sort features so higher EF ratings render last (placing them visually on top)
  const sortedFeatures = [...features].sort((a, b) => {
    const getEf = (feat) => {
      const attrs = feat.properties || feat.attributes || {};
      return firstNonEmpty(attrs.efscale, attrs.EFSCALE, attrs.ef_scale, attrs.damage_txt, attrs.DAMAGE_TXT, 'N/A');
    };
    return getEfRank(getEf(a)) - getEfRank(getEf(b));
  });

  const layers = sortedFeatures
    .map((feature) => {
      if (!feature || !feature.geometry) return null;
      
      const geometry = feature.geometry;
      const attrs = feature.properties || feature.attributes || {};

      const label = firstNonEmpty(attrs.event_id, attrs.EVENT_ID, attrs.objectid, attrs.OBJECTID, attrs.damage_txt, attrs.DAMAGE_TXT, 'DAT');
      const efValue = firstNonEmpty(attrs.efscale, attrs.EFSCALE, attrs.ef_scale, attrs.damage_txt, attrs.DAMAGE_TXT, 'N/A');
      const popupHtml = buildDatPopupHtml(attrs, label, efValue, geometry.type);

      if (geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
        if (!state.datPointsVisible) return null;
        const [lon, lat] = geometry.coordinates;
        const color = getUnifiedTrackColor(efValue);
        const isNonTornado = /TSTM|WIND|TROPICAL/i.test(efValue);

        if (isNonTornado) {
          const marker = L.circleMarker([lat, lon], {
            pane: 'datPointsPane',
            renderer: state.datRenderers.points,
            radius: 6, color: '#ffffff', weight: 1, fillColor: color, fillOpacity: state.datOpacity,
          });
          marker.bindPopup(popupHtml);
          marker.on('popupopen', () => loadDatAttachments(attrs._layerId, attrs._objectId, `dat-img-${attrs._layerId}-${attrs._objectId}`));
          return marker;
        } else {
          const svgIcon = L.divIcon({
            className: 'dat-point-icon',
            html: `<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 14,0 7,14" fill="${color}" stroke="#ffffff" stroke-width="1"/></svg>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7]
          });
          const marker = L.marker([lat, lon], { pane: 'datPointsPane', icon: svgIcon, opacity: state.datOpacity });
          marker.bindPopup(popupHtml);
          marker.on('popupopen', () => loadDatAttachments(attrs._layerId, attrs._objectId, `dat-img-${attrs._layerId}-${attrs._objectId}`));
          return marker;
        }
      }

      if (geometry.type === 'MultiPoint' || geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
        if (!state.datPathsVisible) return null;
        const latLngs = geometry.coordinates ? coordinatesToLatLngs(geometry.coordinates) : [];
        const line = L.polyline(latLngs, {
          pane: 'datLinesPane',
          renderer: state.datRenderers.lines,
          color: getUnifiedTrackColor(efValue), weight: 3, opacity: state.datOpacity,
        });
        
        line.bindPopup(popupHtml);
        
        // Push the DAT length to the corner window when opened, clear when closed
        line.on('popupopen', () => {
          loadDatAttachments(attrs._layerId, attrs._objectId, `dat-img-${attrs._layerId}-${attrs._objectId}`);
        if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
          const lengthMiles = calculateGeometryLength(geometry);
          if (lengthMiles > 0) {
            attrs.calculated_length = `${lengthMiles.toFixed(2)} mi`;
          }
        }
        if (attrs.calculated_length) {
            updateLivePathLength(attrs.calculated_length);
          }
        });
        
        line.on('popupclose', () => {
          updateLivePathLength();
        });
        
        return line;
      }

      if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
        if (!state.datPolygonsVisible) return null;
        
        const polygonLayer = L.geoJSON(feature, {
          style: {
            pane: 'datPolygonsPane',
            renderer: state.datRenderers.polygons,
            color: getUnifiedTrackColor(efValue), 
            fillColor: getUnifiedTrackColor(efValue), 
            fillOpacity: state.datOpacity * 0.35, 
            weight: 2, 
            opacity: state.datOpacity,
          }
        });
        
        polygonLayer.bindPopup(popupHtml);
        polygonLayer.on('popupopen', () => loadDatAttachments(attrs._layerId, attrs._objectId, `dat-img-${attrs._layerId}-${attrs._objectId}`));
        return polygonLayer;
      }
      return null;
    })
    .filter(Boolean);

  layers.forEach((layer) => layer.addTo(state.datLayerGroup));
}

let paletteCache = null;

function getUnifiedTrackColor(value) {
  // 1. Build cache from CSS variables once
  if (!paletteCache) {
    const rootStyle = getComputedStyle(document.documentElement);
    paletteCache = {
      'EF5': rootStyle.getPropertyValue('--ef5').trim(),
      'EF4': rootStyle.getPropertyValue('--ef4').trim(),
      'EF3': rootStyle.getPropertyValue('--ef3').trim(),
      'EF2': rootStyle.getPropertyValue('--ef2').trim(),
      'EF1': rootStyle.getPropertyValue('--ef1').trim(),
      'EF0': rootStyle.getPropertyValue('--ef0').trim(),
      'EFU': rootStyle.getPropertyValue('--efu').trim(),
      'WIND': rootStyle.getPropertyValue('--wind').trim(),
      'TROPICAL': rootStyle.getPropertyValue('--tropical').trim(),
      'OTHER': rootStyle.getPropertyValue('--other').trim(),
    };
  }

  const text = String(value || '').trim().toUpperCase();

  // 2. Check for non-tornado strings
  if (text.includes('TSTM') || text.includes('WIND')) return paletteCache['WIND'];
  if (text.includes('TROPICAL')) return paletteCache['TROPICAL'];
  if (text === 'UNKNOWN' || text === 'N/A' || text === '<NULL>') return paletteCache['OTHER'];
  if (text === 'EFU') return paletteCache['EFU'];

  // 3. Extract the numeric magnitude (handles "4", "EF4", "F4", "EF3+")
  const match = text.match(/\d+/);
  const magnitude = match ? Number(match[0]) : Number(value);

  // 4. Return the standard track color
  if (!Number.isFinite(magnitude)) return paletteCache['OTHER'];
  if (magnitude >= 5) return paletteCache['EF5'];
  if (magnitude >= 4) return paletteCache['EF4'];
  if (magnitude >= 3) return paletteCache['EF3'];
  if (magnitude >= 2) return paletteCache['EF2'];
  if (magnitude >= 1) return paletteCache['EF1'];
  
  return paletteCache['EF0'];
}

function coordinatesToLatLngs(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  return coordinates
    .map((segment) => Array.isArray(segment) && segment.length >= 2 ? [segment[1], segment[0]] : null)
    .filter(Boolean);
}

function applyTheme(mode) {
  state.theme = mode;
  document.body.classList.toggle('theme-light', mode === 'light');
  document.body.classList.toggle('theme-dark', mode === 'dark');

  const themeIcon = document.getElementById('themeToggleIcon');
  if (themeIcon) {
    // When currently dark, show Sun icon to switch to light; when light, show Moon icon
    themeIcon.innerHTML = mode === 'dark' ? SUN_SVG : MOON_SVG;
  }
}

function updateFilterReadouts() {
  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  const yearRangeValue = document.getElementById('yearRangeValue');
  const yearRangeFill = document.getElementById('yearRangeFill');
  const yearStartInput = document.getElementById('yearStartInput');
  const yearEndInput = document.getElementById('yearEndInput');
  const yearStartSlider = document.getElementById('yearStartSlider');
  const yearEndSlider = document.getElementById('yearEndSlider');
  const yearRangeToggleBtn = document.getElementById('yearRangeToggleBtn');

  if (yearMinInput && yearMaxInput) {
    yearMinInput.value = String(Math.min(Number(yearMinInput.value || state.yearMin), state.yearMax));
    yearMaxInput.value = String(Math.max(Number(yearMaxInput.value || state.yearMax), state.yearMin));
    state.yearMin = Number(yearMinInput.value);
    state.yearMax = Number(yearMaxInput.value);
  }

  if (yearStartInput) yearStartInput.value = String(state.yearMin);
  if (yearEndInput) yearEndInput.value = String(state.yearMax);
  if (yearStartSlider) yearStartSlider.value = String(state.yearMin);
  if (yearEndSlider) yearEndSlider.value = String(state.yearMax);

  if (yearRangeValue) {
    yearRangeValue.textContent = state.yearMin === state.yearMax ? String(state.yearMin) : `${state.yearMin}–${state.yearMax}`;
  }

  if (yearRangeFill && yearMinInput && yearMaxInput) {
    const min = Number(yearMinInput.min || state.yearMin);
    const max = Number(yearMaxInput.max || state.yearMax);
    const start = ((state.yearMin - min) / (Math.max(max - min, 1) || 1)) * 100;
    const end = ((state.yearMax - min) / (Math.max(max - min, 1) || 1)) * 100;
    yearRangeFill.style.left = `${start}%`;
    yearRangeFill.style.width = `${Math.max(end - start, 0)}%`;
  }

  const yearMinValue = document.getElementById('yearMinValue');
  const yearMaxValue = document.getElementById('yearMaxValue');

  if (yearMinValue) yearMinValue.textContent = String(state.yearMin);
  if (yearMaxValue) yearMaxValue.textContent = String(state.yearMax);

  if (yearRangeToggleBtn) {
    const showEndYear = yearRangeToggleBtn.getAttribute('aria-expanded') === 'true';
    yearRangeToggleBtn.textContent = showEndYear ? 'Range on' : 'Range';
  }
}

function updateLayerControlStates() {
  const nceiToggle = document.getElementById('nceiLayerToggle');
  const datToggle = document.getElementById('datLayerToggle');
  const spcToggle = document.getElementById('spcToggle');

  const setToggleText = (button, visible) => {
    if (!button) return;
    const nextText = visible ? 'On' : 'Off';
    button.textContent = nextText;
    button.classList.toggle('active', visible);
    button.setAttribute('aria-label', visible ? 'Hide layer' : 'Show layer');
    button.title = visible ? 'Hide layer' : 'Show layer';
  };

  if (nceiToggle) setToggleText(nceiToggle, state.nceiLayerVisible);
  if (datToggle) setToggleText(datToggle, state.datLayerVisible);
  if (spcToggle) setToggleText(spcToggle, state.spcLayerVisible);
}

function updateSpcControls() {
  const spcToggleButton = document.getElementById('spcToggle');
  const spcMultiCountyButton = document.getElementById('spcMultiCountyBtn');

  if (spcToggleButton) {
    const visible = state.spcLayerVisible;
    spcToggleButton.textContent = visible ? 'On' : 'Off';
    spcToggleButton.classList.toggle('active', visible);
    spcToggleButton.setAttribute('aria-label', visible ? 'Hide SPC layer' : 'Show SPC layer');
    spcToggleButton.title = visible ? 'Hide SPC layer' : 'Show SPC layer';
  }

  if (spcMultiCountyButton) {
    spcMultiCountyButton.textContent = state.spcMultiCountyOnly ? 'Multi-county only' : 'All paths';
    spcMultiCountyButton.classList.toggle('active', state.spcMultiCountyOnly);
  }
}

function updateCountyLayerControlStates() {
  const countyToggle = document.getElementById('countyLayerToggle');
  if (!countyToggle) return;

  const visible = state.countyLayerVisible;
  countyToggle.textContent = visible ? 'On' : 'Off';
  countyToggle.classList.toggle('active', visible);
  countyToggle.setAttribute('aria-label', visible ? 'Hide county boundaries' : 'Show county boundaries');
  countyToggle.title = visible ? 'Hide county boundaries' : 'Show county boundaries';
}

function setStatus(message, isError = false) {
  const statusEl = document.getElementById('status');
  if (!statusEl) {
    return;
  }

  // Changed from textContent to innerHTML to allow the spinner HTML to render
  statusEl.innerHTML = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

function normalizeIdentifier(value) {
  if (value === null || value === undefined) return value;

  const text = String(value).trim();
  if (!text || text === 'null' || text === 'NaN') return value;

  const numeric = Number(text);
  if (Number.isFinite(numeric) && Number.isInteger(numeric)) {
    return String(numeric);
  }

  return text;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && trimmed !== 'null' && trimmed !== 'NaN') {
        return value;
      }
      continue;
    }

    if (value !== '' && value !== null && value !== undefined) {
      return value;
    }
  }

  return null;
}

function readFloat(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const text = String(value).trim().replace(/,/g, '');
  if (!text || text === 'null' || text === 'NaN') {
    return fallback;
  }

  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeDateString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  // --- ADD THIS BLOCK ---
  // Handle ArcGIS epoch timestamps (milliseconds since 1970)
  const numValue = Number(value);
  if (!isNaN(numValue) && numValue > 10000000000) {
    const dt = new Date(numValue);
    if (!isNaN(dt.getTime())) {
      // Returns format like "2024-05-05"
      return dt.toISOString().split('T')[0];
    }
  }
  // ----------------------

  const text = String(value).trim();
  if (!text || text === 'null' || text === 'NaN') {
    return null;
  }

  const clean = text.replace(/Z$/, '');

  const isoMatch = clean.match(/^((\d{4})-(\d{2})-(\d{2}))(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    const [, , year, month, day] = isoMatch;
    const dt = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(dt.getTime())) {
      return `${year}-${month}-${day}`;
    }
  }

  const compactMatch = clean.match(/^(\d{4})(\d{2})(\d{2})(?:-(\d{4}))?$/);
  if (compactMatch) {
    const [, year, month, day] = compactMatch;
    const dt = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(dt.getTime())) {
      return `${year}-${month}-${day}`;
    }
  }

  const slashMatch = clean.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashMatch) {
    const [, year, month, day] = slashMatch;
    const dt = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(dt.getTime())) {
      return `${year}-${month}-${day}`;
    }
  }

  const spaceMatch = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (spaceMatch) {
    const [, month, day, year] = spaceMatch;
    const dt = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(dt.getTime())) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

function normalizeTimeString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  if (!text || text === 'null' || text === 'NaN') {
    return null;
  }

  const compact = text.match(/^(\d{8})-(\d{4})$/);
  if (compact) {
    const [, , time] = compact;
    const hour = time.slice(0, 2);
    const minute = time.slice(2, 4);
    return `${hour}:${minute}`;
  }

  const hms = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hms) {
    const [, hour, minute] = hms;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // Check for raw numbers up to 4 digits (e.g., "239", "1430", "5")
  const rawNumber = text.match(/^(\d{1,4})$/);
  if (rawNumber) {
    // Pad the string to exactly 4 characters (e.g., "239" -> "0239", "5" -> "0005")
    const padded = rawNumber[1].padStart(4, '0');
    return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
  }

  return null;
}

function getYearFromDate(dateValue) {
  const normalized = normalizeDateString(dateValue);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(\d{4})-/);
  return match ? Number(match[1]) : null;
}

function refreshYearBounds(initLatest = false) {
  const rows = [...state.rows, ...state.spcRows];
  if (!rows.length) {
    state.yearMin = 1950;
    state.yearMax = 2025;
    return;
  }

  const years = rows
    .map((row) => Number(row.year || getYearFromDate(row.beginDate) || getYearFromDate(row.endDate) || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  let dataMin = 1950;
  let dataMax = 2025;

  if (years.length) {
    dataMin = years[0];
    dataMax = years[years.length - 1];
  }

  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  const yearStartInput = document.getElementById('yearStartInput');
  const yearEndInput = document.getElementById('yearEndInput');
  const yearStartSlider = document.getElementById('yearStartSlider');
  const yearEndSlider = document.getElementById('yearEndSlider');
  
  if (yearMinInput) {
    yearMinInput.min = String(dataMin);
    yearMinInput.max = String(dataMax);
    yearMinInput.value = String(initLatest ? dataMax : dataMax);
  }
  
  if (yearMaxInput) {
    yearMaxInput.min = String(dataMin);
    yearMaxInput.max = String(dataMax);
    yearMaxInput.value = String(initLatest ? dataMax : dataMax);
  }

  if (yearStartInput) {
    yearStartInput.min = String(dataMin);
    yearStartInput.max = String(dataMax);
    yearStartInput.value = String(dataMax);
  }

  if (yearEndInput) {
    yearEndInput.min = String(dataMin);
    yearEndInput.max = String(dataMax);
    yearEndInput.value = String(dataMax);
  }

  if (yearStartSlider) {
    yearStartSlider.min = String(dataMin);
    yearStartSlider.max = String(dataMax);
    yearStartSlider.value = String(dataMax);
  }

  if (yearEndSlider) {
    yearEndSlider.min = String(dataMin);
    yearEndSlider.max = String(dataMax);
    yearEndSlider.value = String(dataMax);
  }

  state.yearMin = Number(yearMinInput?.value || dataMax);
  state.yearMax = Number(yearMaxInput?.value || dataMax);
  updateFilterReadouts();
}

function buildPopup(row) {
  const reportId = row.reportId || row.id || 'N/A';
  const magnitude = row.magnitude ?? row.f2 ?? row.f_2 ?? 'N/A';
  const county = firstNonEmpty(row.county, row.counties, row.state, 'N/A');
  const start = firstNonEmpty(row.beginDate, row.endDate, 'N/A');

  let html = `
    <div class="popup-title">${reportId}</div>
    <div class="popup-grid">
      <span>Magnitude</span><strong>${magnitude}</strong>
      <span>Date</span><strong>${start}</strong>
      <span>County</span><strong>${county}</strong>
      <span>Source</span><strong>${row.source || 'SPC'}</strong>
  `;

  if (row.lengthMiles) html += `<span>Length</span><strong>${row.lengthMiles} mi</strong>`;
  if (row.widthYards) html += `<span>Width</span><strong>${row.widthYards} yd</strong>`;
  if (row.injuries > 0 || row.deaths > 0) {
    html += `<span>Casualties</span><strong>${row.deaths} dead, ${row.injuries} inj</strong>`;
  }
  
  html += `</div>`;

  if (row.details) {
    html += `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--muted); max-height: 120px; overflow-y: auto;">
      ${row.details}
    </div>`;
  }

  return html;
}

function calculateStats(filtered) {
  const maxMagnitude = filtered.reduce((max, row) => Math.max(max, Number(row.magnitude) || 0), 0);
  const maxLength = filtered.reduce((max, row) => {
    const length = Number(row.lengthMiles || row.length_mi || row.length_miles || 0);
    return Math.max(max, Number.isFinite(length) ? length : 0);
  }, 0);

  return {
    count: filtered.length,
    maxMagnitude,
    maxLength,
  };
}

function normalizeRow(row, source) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const beginDate = normalizeDateString(firstNonEmpty(
    row.beginDate,
    row.begin_date,
    row.BEGIN_DATE,
    row.date,
    row.DATE,
    row.eventDate,
    row.event_date,
    row.event_date_utc,
    row.begin_ymd,
    row.BEGIN_YMD,
    row['BEGIN DATE'],
    row['BEGIN DATE (UTC)'],
    row['Date'],
    row.beginTimestamp
  ));

  const endDate = normalizeDateString(firstNonEmpty(
    row.endDate,
    row.end_date,
    row.END_DATE,
    row.end_ymd,
    row.END_YMD,
    row['END DATE'],
    row.endTimestamp
  ));

  const beginTime = normalizeTimeString(firstNonEmpty(
    row.beginTime,
    row.begin_time,
    row.BEGIN_TIME,
    row['BEGIN TIME'],
    row.time,
    row.TIME,
    row['Time'],
    row.beginTimestamp
  ));

  const endTime = normalizeTimeString(firstNonEmpty(
    row.endTime,
    row.end_time,
    row.END_TIME,
    row['END TIME']
  ));

  const beginLatitude = readFloat(firstNonEmpty(
    row.beginLatitude,
    row.begin_lat,
    row.BEGIN_LAT,
    row.BEGINLAT,
    row.lat,
    row.latitude,
    row['Begin Lat'],
    row.slat
  ));

  const beginLongitude = readFloat(firstNonEmpty(
    row.beginLongitude,
    row.begin_lon,
    row.BEGIN_LON,
    row.BEGINLON,
    row.lon,
    row.longitude,
    row['Begin Lon'],
    row.slon
  ));

  let endLatitude = readFloat(firstNonEmpty(
    row.endLatitude,
    row.end_lat,
    row.END_LAT,
    row.ENDLAT,
    row['End Lat'],
    row.elat
  ));

  let endLongitude = readFloat(firstNonEmpty(
    row.endLongitude,
    row.end_lon,
    row.END_LON,
    row.ENDLON,
    row['End Lon'],
    row.elon
  ));

  const invalidLatLng = (value) => value === null || value === undefined || value === 0 || Math.abs(value) >= 99900;

  if (invalidLatLng(beginLatitude) || invalidLatLng(beginLongitude)) {
    return null;
  }

  if (invalidLatLng(endLatitude) || invalidLatLng(endLongitude)) {
    endLatitude = beginLatitude;
    endLongitude = beginLongitude;
  }

  const magnitudeCandidates = [
    row.magnitude,
    row.mag,
    row.MAG,
    row.fscale,
    row.f_scale,
    row.F_SCALE,
    row.f2,
    row.f_2,
    row.F2,
    row.efscale,
    row.ef_scale,
    row.EFSCALE,
    row.EF_SCALE,
    row['F scale'],
    row['F Scale'],
    row['Magnitude'],
  ];

  let magnitude = 0;
  for (const candidate of magnitudeCandidates) {
    const rawVal = String(candidate || '').trim().toUpperCase();
    if (rawVal === 'EFU') {
      magnitude = 'EFU';
      break;
    }
    const parsed = readFloat(candidate, null);
    if (parsed !== null) {
      magnitude = parsed;
      break;
    }
  }

  if (typeof row.magnitude === 'string' && /^(f|ef)/i.test(row.magnitude.trim())) {
    const upperText = row.magnitude.trim().toUpperCase();
    if (upperText === 'EFU') {
      magnitude = 'EFU';
    } else {
      const match = upperText.match(/(\d+)/);
      if (match) {
        magnitude = Number(match[1]);
      }
    }
  }

  if (typeof row.magnitude === 'string' && /^(f|ef)/i.test(row.magnitude.trim())) {
    const match = row.magnitude.trim().match(/(\d+)/);
    if (match) {
      magnitude = Number(match[1]);
    }
  }

  const id = firstNonEmpty(
    row.stormEventsReportID, 
    row.StormEventsReportID,
    row.oneTorID,
    row.id,
    row.reportId,
    row.report_id,
    row.REPORT_ID,
    row['Report ID'],
    row.event_id,
    row.EVENT_ID,
    row.objectid,
    row.OBJECTID,
    row.om,
    `${beginDate || 'unknown'}-${beginTime || '00:00'}-${beginLatitude || 0}-${beginLongitude || 0}`
  );

  const normalized = {
    _raw: row, // Keep full original column set for inspection
    id: String(id ?? `${source}-${Math.random().toString(16).slice(2)}`),
    reportId: normalizeIdentifier(firstNonEmpty(row.stormEventsReportID, row.StormEventsReportID, row.reportId, row.report_id, row.REPORT_ID, id, 'UNKNOWN')),
    source,
    beginDate: beginDate || endDate || '0000-00-00',
    beginTime: beginTime || '00:00',
    endDate: endDate || beginDate || '0000-00-00',
    endTime: endTime || beginTime || '00:00',
    beginLatitude,
    beginLongitude,
    endLatitude,
    endLongitude,
    magnitude,
    year: Number(firstNonEmpty(row.year, row.yr, getYearFromDate(beginDate), getYearFromDate(endDate), 0) || 0),
    county: firstNonEmpty(row.county, row.COUNTY, row.counties, row['County'], 'Unknown'),
    state: firstNonEmpty(row.state, row.STATE, row['State'], 'Unknown'),
    lengthMiles: readFloat(firstNonEmpty(row.tornadoLength, row.lengthMiles, row.length_mi, row.length_miles, row['Length (mi)'], row['Length miles'], 0), 0),
    widthYards: readFloat(firstNonEmpty(row.tornadoWidth, 0), 0),
    injuries: readFloat(row.injuriesDirect, 0),
    deaths: readFloat(row.deathsDirect, 0),
    details: firstNonEmpty(row.details, row.overview, ''),
    f2: row.f2,
    f_2: row.f_2,
    multi_county: row.multi_county,
    multiCounty: row.multiCounty,
  };

  if (normalized.beginDate === '0000-00-00' || !normalized.beginLatitude || !normalized.beginLongitude) {
    return null;
  }

  return normalized;
}

function parseDatRecords(text) {
  if (!text || !String(text).trim()) {
    return [];
  }

  const rows = [];
  const lines = String(text).split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const parts = line.split(/[	,|]+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 7) {
      continue;
    }

    const record = {
      reportId: parts[0],
      beginDate: parts[1],
      beginTime: parts[2],
      endDate: parts[3],
      endTime: parts[4],
      beginLatitude: Number(parts[5]),
      beginLongitude: Number(parts[6]),
      endLatitude: Number(parts[7] || parts[5]),
      endLongitude: Number(parts[8] || parts[6]),
      magnitude: Number(parts[9] || 0),
      source: 'DAT',
    };

    const normalized = normalizeRow(record, 'DAT');
    if (normalized) {
      rows.push(normalized);
    }
  }

  return rows;
}

function getSelectedRecord() {
  if (!state.selectedId) {
    return null;
  }

  return state.filtered.find((row) => row.id === state.selectedId) || state.rows.find((row) => row.id === state.selectedId) || null;
}

function getDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function zoomToConus() {
  if (!state.map) return;

  const conusBounds = L.latLngBounds(
    [24.5, -125],
    [49.5, -66.5]
  );

  state.map.fitBounds(conusBounds, {
    padding: [24, 24],
    maxZoom: 6
  });
}

function zoomToSelectedTrack() {
  const record = getSelectedRecord();
  if (!record || !state.map) return;

  const start = [record.beginLatitude, record.beginLongitude];
  const end = [record.endLatitude, record.endLongitude];
  const trackBounds = L.latLngBounds([start, end]);

  if (trackBounds.isValid()) {
    state.map.fitBounds(trackBounds, {
      padding: [60, 60],
      maxZoom: 12
    });
  }
}

function renderDetailsPanel(record) {
  const panel = document.getElementById('trackDetailsPanel');
  if (!panel) return;

  if (!record || record.source === 'SPC') {
    panel.classList.add('hidden');
    return;
  }

  const titleEl = document.getElementById('detailsTitle');
  const subEl = document.getElementById('detailsSubtitle');
  const tbody = document.getElementById('detailsTableBody');
  const overviewSec = document.getElementById('detailsOverviewSection');
  const overviewText = document.getElementById('detailsOverviewText');

  if (titleEl) titleEl.textContent = record.reportId || record.id || 'Tornado Record';
  if (subEl) subEl.textContent = `${record.state || ''} • ${record.beginDate || ''} • EF/F${record.magnitude ?? 'N/A'}`;

  // Narrative overview
  const narrative = record.details || record.overview;
  if (overviewSec && overviewText) {
    if (narrative && narrative.trim()) {
      overviewText.textContent = narrative.trim();
      overviewSec.classList.remove('hidden');
    } else {
      overviewSec.classList.add('hidden');
    }
  }

  // Build the complete key-value table
  if (tbody) {
    const rawData = record._raw || record;
    const skipKeys = new Set(['_raw', 'details', 'overview']);
    
    const rows = Object.entries(rawData)
      .filter(([k, v]) => !skipKeys.has(k) && v !== null && v !== undefined && String(v).trim() !== '')
      .map(([key, value]) => `
        <tr>
          <th>${escapeHtml(key)}</th>
          <td>${escapeHtml(String(value))}</td>
        </tr>
      `).join('');

    tbody.innerHTML = rows;
  }

  panel.classList.remove('hidden');
}

function hideDetailsPanel() {
  const panel = document.getElementById('trackDetailsPanel');
  if (panel) panel.classList.add('hidden');
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

function resolveAssetUrl(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized) return normalized;

  try {
    return new URL(normalized, window.location.href).href;
  } catch {
    const safe = normalized.replace(/^\.\//, '').replace(/^\//, '');
    return `${window.location.origin}/${safe}`;
  }
}

function getSpcRadarTimeInfo(record) {
  const dateStr = normalizeDateString(record.beginDate || record.endDate);
  const timeStr = normalizeTimeString(record.beginTime || '00:00');
  if (!dateStr || !timeStr) return { dateStr, timeStr, offsetMinutes: 0 };

  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute));

  const localOffsetMinutes = new Date(year, month - 1, day, hour, minute).getTimezoneOffset();
  const utcDate = new Date(parsed.getTime() - localOffsetMinutes * 60 * 1000);
  const utcMinutes = Math.round((utcDate.getTime() - Date.UTC(year, month - 1, day, 0, 0)) / 60000);

  return {
    dateStr,
    timeStr,
    offsetMinutes: localOffsetMinutes,
    utcDate,
    utcMinutes,
  };
}

function updateExportButtonLabel() {
  const countBadge = document.getElementById('exportCountBadge');
  const count = state.corrections ? state.corrections.size : 0;
  
  if (countBadge) {
    countBadge.textContent = count > 0 ? `(${count})` : '';
  }
}

function renderEditor() {
  const form = document.getElementById('segmentForm');
  const empty = document.getElementById('selectionEmpty');
  const record = getSelectedRecord();
  const pathLookupPanel = document.getElementById('pathLookupPanel');

  if (pathLookupPanel) {
    pathLookupPanel.classList.toggle('hidden', Boolean(record));
  }

  if (!record) {
    if (form) form.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    if (state.editLayerGroup) state.editLayerGroup.clearLayers();
    return;
  }

  if (form) form.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

  const reportIdField = document.getElementById('reportId');
  if (reportIdField) reportIdField.value = record.reportId || record.id || '';

  document.getElementById('beginDate').value = record.beginDate || '';
  document.getElementById('beginTime').value = record.beginTime || '';
  document.getElementById('endDate').value = record.endDate || '';
  document.getElementById('endTime').value = record.endTime || '';
  document.getElementById('beginLat').value = record.beginLatitude ?? '';
  document.getElementById('beginLon').value = record.beginLongitude ?? '';
  document.getElementById('endLat').value = record.endLatitude ?? '';
  document.getElementById('endLon').value = record.endLongitude ?? '';
  document.getElementById('pathLength').value = record.lengthMiles ?? '';
  document.getElementById('pathWidth').value = record.widthYards ?? '';
  document.getElementById('qcNotes').value = record.qcNotes || '';
}

function getEfRank(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'EF5' || text === 'F5') return 5;
  if (text === 'EF4' || text === 'F4') return 4;
  if (text.startsWith('EF3') || text.startsWith('F3')) return 3; // Catch EF3+
  if (text === 'EF2' || text === 'F2') return 2;
  if (text === 'EF1' || text === 'F1') return 1;
  if (text === 'EF0' || text === 'F0') return 0;
  return -1; // Unrated, wind, or other types go to the very bottom
}

function updateLivePathLength(datLengthStr = null) {
  const display = document.getElementById('mapPathLength');
  if (!display) return;
  
  const record = getSelectedRecord();
  let mainText = '';
  
  if (record && state.editHandles.start && state.editHandles.end) {
    const s = state.editHandles.start.getLatLng();
    const e = state.editHandles.end.getLatLng();
    const dist = getDistanceMiles(s.lat, s.lng, e.lat, e.lng);
    mainText = `Track: ${dist.toFixed(2)} mi`;
  }
  
  if (!mainText && !datLengthStr) {
    display.classList.add('hidden');
    return;
  }
  
  display.classList.remove('hidden');
  
  let html = '';
  if (mainText) {
    html += `<div>${mainText}</div>`;
  }
  if (datLengthStr) {
    // Adds a slightly dimmer secondary row for the DAT length
    html += `<div style="color: #a8a29e; font-size: 0.9em; margin-top: 2px;">DAT: ${datLengthStr}</div>`;
  }
  
  display.innerHTML = html;
}

function calculateGeometryLength(geometry) {
  if (!geometry || !geometry.coordinates) return 0;
  let totalMiles = 0;

  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      totalMiles += getDistanceMiles(coords[i][1], coords[i][0], coords[i+1][1], coords[i+1][0]);
    }
  } else if (geometry.type === 'MultiLineString') {
    for (const line of geometry.coordinates) {
      for (let i = 0; i < line.length - 1; i++) {
        totalMiles += getDistanceMiles(line[i][1], line[i][0], line[i+1][1], line[i+1][0]);
      }
    }
  }
  return totalMiles;
}