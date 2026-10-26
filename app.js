const SPC_URL = 'https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv';
const FALLBACK_URL = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(SPC_URL);

const state = {
  rows: [],
  spcRows: [],
  filtered: [],
  map: null,
  layerGroup: null,
  datLayerGroup: null,
  radarLayer: null,
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
  spcMultiCountyOnly: false,
  datPointsVisible: true,
  datPathsVisible: true,
  datPolygonsVisible: true,
  radarActive: false,
  radarTimeOffsetMins: 0,
};

// --- UTILITY FUNCTIONS ---

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && trimmed !== 'null' && trimmed !== 'NaN') return value;
      continue;
    }
    if (value !== '' && value !== null && value !== undefined) return value;
  }
  return null;
}

function readFloat(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value).trim().replace(/,/g, '');
  if (!text || text === 'null' || text === 'NaN') return fallback;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeDateString(value) {
  if (value === null || value === undefined) return null;

  const numValue = Number(value);
  if (!isNaN(numValue) && numValue > 10000000000) {
    const dt = new Date(numValue);
    if (!isNaN(dt.getTime())) return dt.toISOString().split('T')[0];
  }

  const text = String(value).trim();
  if (!text || text === 'null' || text === 'NaN') return null;
  const clean = text.replace(/Z$/, '');

  const isoMatch = clean.match(/^((\d{4})-(\d{2})-(\d{2}))(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    const [, , year, month, day] = isoMatch;
    const dt = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(dt.getTime())) return `${year}-${month}-${day}`;
  }

  const compactMatch = clean.match(/^(\d{4})(\d{2})(\d{2})(?:-(\d{4}))?$/);
  if (compactMatch) {
    const [, year, month, day] = compactMatch;
    const dt = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(dt.getTime())) return `${year}-${month}-${day}`;
  }

  const slashMatch = clean.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashMatch) {
    const [, year, month, day] = slashMatch;
    const dt = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(dt.getTime())) return `${year}-${month}-${day}`;
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
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text === 'null' || text === 'NaN') return null;

  const compact = text.match(/^(\d{8})-(\d{4})$/);
  if (compact) {
    const [, , time] = compact;
    return `${time.slice(0, 2)}:${time.slice(2, 4)}`;
  }

  const hms = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hms) return `${String(hms[1]).padStart(2, '0')}:${String(hms[2]).padStart(2, '0')}`;

  const hourMinute = text.match(/^(\d{4})$/);
  if (hourMinute) return `${hourMinute[1].slice(0, 2)}:${hourMinute[1].slice(2, 4)}`;

  return null;
}

function getYearFromDate(dateValue) {
  const normalized = normalizeDateString(dateValue);
  if (!normalized) return null;
  const match = normalized.match(/^(\d{4})-/);
  return match ? Number(match[1]) : null;
}

function normalizeRow(row, source) {
  if (!row || typeof row !== 'object') return null;

  const beginDate = normalizeDateString(firstNonEmpty(
    row.beginDate, row.begin_date, row.BEGIN_DATE, row.date, row.DATE, row.eventDate, 
    row.event_date, row.event_date_utc, row.begin_ymd, row.BEGIN_YMD, row['BEGIN DATE'], 
    row['BEGIN DATE (UTC)'], row['Date'], row.beginTimestamp
  ));

  const endDate = normalizeDateString(firstNonEmpty(
    row.endDate, row.end_date, row.END_DATE, row.end_ymd, row.END_YMD, row['END DATE'], row.endTimestamp
  ));

  const beginTime = normalizeTimeString(firstNonEmpty(
    row.beginTime, row.begin_time, row.BEGIN_TIME, row['BEGIN TIME'], row.time, 
    row.TIME, row['Time'], row.beginTimestamp
  ));

  const endTime = normalizeTimeString(firstNonEmpty(
    row.endTime, row.end_time, row.END_TIME, row['END TIME']
  ));

  const beginLatitude = readFloat(firstNonEmpty(
    row.beginLatitude, row.begin_lat, row.BEGIN_LAT, row.BEGINLAT, row.lat, 
    row.latitude, row['Begin Lat'], row.slat
  ));

  const beginLongitude = readFloat(firstNonEmpty(
    row.beginLongitude, row.begin_lon, row.BEGIN_LON, row.BEGINLON, row.lon, 
    row.longitude, row['Begin Lon'], row.slon
  ));

  let endLatitude = readFloat(firstNonEmpty(
    row.endLatitude, row.end_lat, row.END_LAT, row.ENDLAT, row['End Lat'], row.elat
  ));

  let endLongitude = readFloat(firstNonEmpty(
    row.endLongitude, row.end_lon, row.END_LON, row.ENDLON, row['End Lon'], row.elon
  ));

  const invalidLatLng = (value) => value === null || value === undefined || value === 0 || Math.abs(value) >= 99900;
  if (invalidLatLng(beginLatitude) || invalidLatLng(beginLongitude)) return null;
  if (invalidLatLng(endLatitude) || invalidLatLng(endLongitude)) {
    endLatitude = beginLatitude;
    endLongitude = beginLongitude;
  }

  const magnitudeCandidates = [
    row.magnitude, row.mag, row.MAG, row.fscale, row.f_scale, row.F_SCALE, 
    row.f2, row.f_2, row.F2, row.efscale, row.ef_scale, row.EFSCALE, 
    row.EF_SCALE, row['F scale'], row['F Scale'], row['Magnitude'],
  ];

  let magnitude = 0;
  for (const candidate of magnitudeCandidates) {
    const parsed = readFloat(candidate, null);
    if (parsed !== null) {
      magnitude = parsed;
      break;
    }
  }

  if (typeof row.magnitude === 'string' && /^(f|ef)/i.test(row.magnitude.trim())) {
    const match = row.magnitude.trim().match(/(\d+)/);
    if (match) magnitude = Number(match[1]);
  }

  const id = firstNonEmpty(
    row.stormEventsReportID, row.StormEventsReportID, row.oneTorID, row.id, 
    row.reportId, row.report_id, row.REPORT_ID, row['Report ID'], row.event_id, 
    row.EVENT_ID, row.objectid, row.OBJECTID, row.om, 
    `${beginDate || 'unknown'}-${beginTime || '00:00'}-${beginLatitude || 0}-${beginLongitude || 0}`
  );

  const normalized = {
    id: String(id ?? `${source}-${Math.random().toString(16).slice(2)}`),
    reportId: String(firstNonEmpty(row.stormEventsReportID, row.StormEventsReportID, row.reportId, row.report_id, row.REPORT_ID, id, 'UNKNOWN')),
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
    
    // Preserve original string values for SPC multi-county logic
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

document.addEventListener('DOMContentLoaded', init);

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
      if (!response.ok) continue;
      const text = await response.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => String(h).trim() });
      const rows = parsed.data.map((row) => normalizeRow(row, 'CSV')).filter(Boolean);
      if (rows.length) loaded.push(...rows);
    } catch (error) {
      console.warn(`Skipping bundled CSV ${fileName}:`, error);
    }
  }
  return loaded;
}

async function fetchCsvWithFallback() {
  try {
    const response = await fetch(SPC_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Primary fetch failed: ${response.status}`);
    return await response.text();
  } catch (err) {
    console.warn('Primary fetch failed, trying fallback.', err);
    const fallbackResponse = await fetch(FALLBACK_URL, { cache: 'no-store' });
    if (!fallbackResponse.ok) throw new Error(`Fallback failed: ${fallbackResponse.status}`);
    return fallbackResponse.text();
  }
}

async function loadSpcRows() {
  try {
    const csvText = await fetchCsvWithFallback();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true, transformHeader: (h) => String(h).trim() });
    return parsed.data.map((row) => normalizeRow(row, 'SPC')).filter(Boolean);
  } catch (error) {
    console.warn('Unable to load SPC rows:', error);
    return [];
  }
}

async function loadData() {
  try {
    let rows = await loadBundledReportParts();
    if (!rows.length) {
      const csvText = await fetchCsvWithFallback();
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true, transformHeader: (h) => String(h).trim() });
      rows = parsed.data.map((row) => normalizeRow(row, 'SPC')).filter(Boolean);
    }

    state.rows = rows.sort((a, b) => String(a.beginDate || '').localeCompare(String(b.beginDate || '')) || 
                                     String(a.beginTime || '').localeCompare(String(b.beginTime || '')));
    state.spcRows = await loadSpcRows();

    if (!state.rows.length && !state.spcRows.length) {
      throw new Error('No usable tornado rows were found.');
    }

    refreshYearBounds();
    renderFilteredData({ preserveMapView: true });
    setStatus(`Loaded ${state.rows.length.toLocaleString()} primary report rows and ${state.spcRows.length.toLocaleString()} SPC rows.`);
  } catch (error) {
    console.error(error);
    setStatus('Unable to load tornado CSV. Check internet connection or upload local CSV.', true);
  }
}

async function init() {
  const mapElement = document.getElementById('map');
  state.map = L.map(mapElement, { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([38.5, -98.35], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(state.map);

  // Radar pane behind DAT polygons
  state.map.createPane('radarPane');
  state.map.getPane('radarPane').style.zIndex = 380;
  state.map.getPane('radarPane').style.opacity = 0.65;

  state.map.createPane('datPolygonsPane');
  state.map.getPane('datPolygonsPane').style.zIndex = 390;
  state.map.createPane('datLinesPane');
  state.map.getPane('datLinesPane').style.zIndex = 400;
  state.map.createPane('datPointsPane');
  state.map.getPane('datPointsPane').style.zIndex = 410;

  state.layerGroup = L.layerGroup().addTo(state.map);
  state.datLayerGroup = L.layerGroup().addTo(state.map);
  
  injectRadarUI();
  bindControls();
  updateSpcControls();
  applyTheme('dark');
  await loadData();
}

function injectRadarUI() {
  const form = document.getElementById('segmentForm');
  if (!form || document.getElementById('radarControls')) return;

  const radarHTML = `
    <div id="radarControls" class="field-row" style="margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);">
      <label style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:700; color:var(--text);">IEM NEXRAD Radar</span>
        <button id="radarToggleBtn" type="button" class="secondary" style="width:auto; padding:4px 8px; font-size:0.75rem;">Show Radar</button>
      </label>
      <div id="radarSliderWrap" class="hidden" style="margin-top:6px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:0.75rem; color:var(--accent);">
          <span>-60 min</span>
          <strong id="radarTimeLabel">Tornado Time</strong>
          <span>+60 min</span>
        </div>
        <input id="radarTimeOffset" type="range" min="-60" max="60" step="5" value="0" style="width:100%;">
      </div>
    </div>
  `;
  form.insertAdjacentHTML('beforeend', radarHTML);
}

function bindControls() {
  const bindChange = (id, callback) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', callback);
  };
  const bindClick = (id, callback) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', callback);
  };

  bindChange('yearMin', () => {
    const min = document.getElementById('yearMin');
    const max = document.getElementById('yearMax');
    if (Number(min.value) > Number(max.value)) max.value = min.value;
    state.yearMin = Number(min.value);
    updateFilterReadouts();
    renderFilteredData({ preserveMapView: true });
  });

  bindChange('yearMax', () => {
    const min = document.getElementById('yearMin');
    const max = document.getElementById('yearMax');
    if (Number(max.value) < Number(min.value)) min.value = max.value;
    state.yearMax = Number(max.value);
    updateFilterReadouts();
    renderFilteredData({ preserveMapView: true });
  });

  bindChange('magnitudeMin', () => {
    state.minMagnitude = Number(document.getElementById('magnitudeMin').value);
    updateFilterReadouts();
    renderFilteredData();
  });

  bindClick('spcToggle', () => {
    state.spcLayerVisible = !state.spcLayerVisible;
    updateSpcControls();
    renderFilteredData({ preserveMapView: true });
  });

  bindClick('spcMultiCountyBtn', () => {
    state.spcMultiCountyOnly = !state.spcMultiCountyOnly;
    updateSpcControls();
    renderFilteredData({ preserveMapView: true });
  });

  ['datPolyToggle', 'datPathToggle', 'datPointToggle'].forEach(id => {
    bindClick(id, (e) => {
      if (id === 'datPolyToggle') state.datPolygonsVisible = !state.datPolygonsVisible;
      if (id === 'datPathToggle') state.datPathsVisible = !state.datPathsVisible;
      if (id === 'datPointToggle') state.datPointsVisible = !state.datPointsVisible;
      e.target.classList.toggle('active');
      renderDatLayer(state.noaaDatMatches);
    });
  });

  bindClick('radarToggleBtn', (e) => {
    state.radarActive = !state.radarActive;
    e.target.textContent = state.radarActive ? 'Hide Radar' : 'Show Radar';
    e.target.classList.toggle('active', state.radarActive);
    document.getElementById('radarSliderWrap').classList.toggle('hidden', !state.radarActive);
    updateRadarLayer();
  });

  bindChange('radarTimeOffset', (e) => {
    state.radarTimeOffsetMins = Number(e.target.value);
    updateRadarLayer();
  });

  bindClick('resetViewBtn', () => {
    if (state.allBounds && state.allBounds.isValid()) state.map.fitBounds(state.allBounds, { padding: [24, 24] });
  });

  bindClick('clearSelection', () => {
    state.selectedId = null;
    state.radarActive = false;
    if (state.radarLayer) { state.map.removeLayer(state.radarLayer); state.radarLayer = null; }
    renderEditor();
    setStatus('Selection cleared.');
  });
}

function renderEditor() {
  const form = document.getElementById('segmentForm');
  const empty = document.getElementById('selectionEmpty');
  const selectionLabel = document.getElementById('selectionLabel');
  const record = getSelectedRecord();

  if (!record) {
    if (form) form.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    if (selectionLabel) selectionLabel.textContent = '';
    return;
  }

  if (form) form.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

  document.getElementById('reportId').value = record.reportId || record.id || '';
  document.getElementById('beginDate').value = record.beginDate || '';
  document.getElementById('beginTime').value = record.beginTime || '';
  document.getElementById('endDate').value = record.endDate || '';
  document.getElementById('endTime').value = record.endTime || '';
  document.getElementById('beginLat').value = record.beginLatitude ?? '';
  document.getElementById('beginLon').value = record.beginLongitude ?? '';
  document.getElementById('endLat').value = record.endLatitude ?? '';
  document.getElementById('endLon').value = record.endLongitude ?? '';

  if (selectionLabel) selectionLabel.textContent = `${record.source || 'Report'} • ${record.beginDate || 'n/a'} • ${record.magnitude ?? 'n/a'}`;

  // Reset radar state for new selection
  state.radarTimeOffsetMins = 0;
  const radarSlider = document.getElementById('radarTimeOffset');
  if (radarSlider) radarSlider.value = 0;
  if (state.radarActive) updateRadarLayer();
}

function updateRadarLayer() {
  if (state.radarLayer) {
    state.map.removeLayer(state.radarLayer);
    state.radarLayer = null;
  }

  if (!state.radarActive) return;

  const record = getSelectedRecord();
  if (!record || !record.beginDate || !record.beginTime) {
    document.getElementById('radarTimeLabel').textContent = "No valid time";
    return;
  }

  // Format: "YYYY-MM-DD" and "HH:MM" -> IEM needs UTC "YYYY-MM-DDTHH:MM:00Z"
  // Assuming tornado times are already UTC. If they are local, this requires time zone math.
  const dtStr = `${record.beginDate}T${record.beginTime}:00Z`;
  const baseTime = new Date(dtStr);
  
  if (isNaN(baseTime.getTime())) {
    document.getElementById('radarTimeLabel').textContent = "Invalid time";
    return;
  }

  const offsetTime = new Date(baseTime.getTime() + (state.radarTimeOffsetMins * 60000));
  const timeParam = offsetTime.toISOString().replace('.000', '');

  const lbl = state.radarTimeOffsetMins === 0 ? "Tornado Time" : 
              state.radarTimeOffsetMins > 0 ? `+${state.radarTimeOffsetMins} min` : 
              `${state.radarTimeOffsetMins} min`;
  document.getElementById('radarTimeLabel').textContent = lbl;

  // Use n0q (Base Reflectivity) WMS layer from IEM
  state.radarLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
    layers: 'nexrad-n0q-900913',
    format: 'image/png',
    transparent: true,
    time: timeParam,
    pane: 'radarPane'
  }).addTo(state.map);
}

function isMultiCountyRow(row) {
  if (!row) return false;
  // SPC official format encodes multi-county tracks by setting f2, f_2, or multi_county to 1
  const candidateValues = [
    row.f2, row.f_2, row.multiCounty, row.multi_county
  ];
  for (const value of candidateValues) {
    const numeric = Number.parseFloat(String(value ?? '').replace(/,/g, '').trim());
    if (Number.isFinite(numeric) && numeric === 1) return true;
  }
  return false;
}

function renderFilteredData(options = {}) {
  const { preserveMapView = false } = options;
  const primaryRows = state.rows.filter((row) => {
    const rowYear = Number(row.year || getYearFromDate(row.beginDate));
    return rowYear >= state.yearMin && rowYear <= state.yearMax && row.magnitude >= state.minMagnitude;
  });

  let spcRows = [];
  if (state.spcLayerVisible) {
    spcRows = state.spcRows.filter((row) => {
      const rowYear = Number(row.year || getYearFromDate(row.beginDate));
      const inRange = rowYear >= state.yearMin && rowYear <= state.yearMax && row.magnitude >= state.minMagnitude;
      const multiCountyPass = !state.spcMultiCountyOnly || isMultiCountyRow(row);
      return inRange && multiCountyPass;
    });
  }

  const filtered = [...primaryRows, ...spcRows];
  state.filtered = filtered;
  if (state.polyLines) state.polyLines.clear();
  if (state.layerGroup) state.layerGroup.clearLayers();

  if (!filtered.length) {
    document.getElementById('trackCount').textContent = '0';
    document.getElementById('maxMagnitude').textContent = '0';
    document.getElementById('maxLength').textContent = '0 mi';
    setStatus('No tornado tracks match the selected filters.', false);
    return;
  }

  let bounds = L.latLngBounds([]);

  filtered.forEach((row) => {
    const isSpc = row.source === 'SPC';
    const color = magnitudeColor(row.magnitude);
    const startPoint = [row.beginLatitude, row.beginLongitude];
    const endPoint = [row.endLatitude, row.endLongitude];
    const polyline = L.polyline([startPoint, endPoint], {
      color,
      weight: row.id === state.selectedId ? 6 : 3,
      opacity: row.id === state.selectedId ? 1 : 0.8,
      lineCap: 'round',
      dashArray: isSpc ? '8 8' : null,
    });

    polyline.bindPopup(buildPopup(row));
    polyline.on('click', async (event) => {
      L.DomEvent.stopPropagation(event);
      await handleTrackSelection(row, true);
    });
    polyline.addTo(state.layerGroup);
    state.polyLines.set(row.id, polyline);

    const startMarker = L.circleMarker(startPoint, {
      radius: 4, color: '#f8fafc', fillColor: color, fillOpacity: 1, weight: 1,
    });
    startMarker.bindPopup(buildPopup(row));
    startMarker.on('click', async (event) => {
      L.DomEvent.stopPropagation(event);
      await handleTrackSelection(row, true);
    });
    startMarker.addTo(state.layerGroup);
    bounds.extend([startPoint, endPoint]);
  });

  const stats = calculateStats(filtered);
  document.getElementById('trackCount').textContent = stats.count.toLocaleString();
  document.getElementById('maxMagnitude').textContent = String(stats.maxMagnitude);
  document.getElementById('maxLength').textContent = `${stats.maxLength.toFixed(0)} mi`;

  state.allBounds = bounds;
  if (bounds.isValid() && !preserveMapView) state.map.fitBounds(bounds, { padding: [30, 30] });
  renderEditor();
  setStatus(`Showing ${filtered.length.toLocaleString()} tracks.`, false);
}

async function handleTrackSelection(record, preserveMapView = true) {
  if (!record) return;
  state.selectedId = record.id;
  renderEditor();
  renderFilteredData({ preserveMapView: true });

  const dateLabel = record.beginDate || record.endDate || 'this date';

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
  state.noaaDatMatches = matches || [];
  renderDatLayer(matches || []);

  if (matches && matches.length) {
    setStatus(`Selected ${record.reportId || record.id}. DAT found ${matches.length} feature(s).`, false);
  } else {
    setStatus(`Selected ${record.reportId || record.id}. 0 DAT features found.`, false);
  }
}

function clearDatLayer() {
  if (state.datLayerGroup) state.datLayerGroup.clearLayers();
}

function renderDatLayer(features) {
  clearDatLayer();
  if (!features || !features.length || !state.datLayerGroup) return;

  const layers = features
    .map((feature) => {
      if (!feature || !feature.geometry) return null;

      const geometry = feature.geometry;
      const attrs = feature.properties || feature.attributes || {};
      const label = firstNonEmpty(attrs.event_id, attrs.EVENT_ID, attrs.objectid, attrs.OBJECTID, attrs.damage_txt, attrs.DAMAGE_TXT, 'DAT');
      const efValue = firstNonEmpty(attrs.efscale, attrs.EFSCALE, attrs.ef_scale, attrs.damage_txt, attrs.DAMAGE_TXT, 'N/A');
      
      const popupHtml = `
        <div class="popup-title">NOAA DAT</div>
        <div class="popup-grid">
          <span>Event</span><strong>${label}</strong>
          <span>EF/Type</span><strong>${efValue}</strong>
          <span>Damage</span><strong>${firstNonEmpty(attrs.damage_txt, attrs.DAMAGE_TXT, 'N/A')}</strong>
        </div>
      `;

      if (geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
        if (!state.datPointsVisible) return null;
        const [lon, lat] = geometry.coordinates;
        const color = datColorByEf(efValue);
        
        if (/TSTM|WIND|TROPICAL/i.test(efValue)) {
          const marker = L.circleMarker([lat, lon], { pane: 'datPointsPane', radius: 5, color: '#ffffff', weight: 1, fillColor: color, fillOpacity: 1 });
          marker.bindPopup(popupHtml); return marker;
        } else {
          const svgIcon = L.divIcon({ className: 'dat-point-icon', html: `<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 14,0 7,14" fill="${color}" stroke="#ffffff" stroke-width="1"/></svg>`, iconSize: [14, 14], iconAnchor: [7, 7] });
          const marker = L.marker([lat, lon], { pane: 'datPointsPane', icon: svgIcon });
          marker.bindPopup(popupHtml); return marker;
        }
      }

      if (geometry.type === 'MultiPoint' || geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
        if (!state.datPathsVisible) return null;
        const latLngs = geometry.coordinates ? coordinatesToLatLngs(geometry.coordinates) : [];
        const line = L.polyline(latLngs, { pane: 'datLinesPane', color: datColorByEf(efValue), weight: 3, opacity: 0.9 });
        line.bindPopup(popupHtml); return line;
      }

      if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
        if (!state.datPolygonsVisible) return null;
        const latLngs = geometry.coordinates ? polygonCoordinatesToLatLngs(geometry.coordinates) : [];
        const polygon = L.polygon(latLngs, { pane: 'datPolygonsPane', color: datColorByEf(efValue), fillColor: datColorByEf(efValue), fillOpacity: 0.35, weight: 2 });
        polygon.bindPopup(popupHtml); return polygon;
      }
      return null;
    })
    .filter(Boolean);

  layers.forEach((layer) => layer.addTo(state.datLayerGroup));
}

function datColorByEf(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text.includes('TSTM') || text.includes('WIND')) return '#8b5cf6';
  if (text.includes('TROPICAL')) return '#10b981';
  if (text === 'UNKNOWN' || text === 'N/A' || text === '<NULL>') return '#a8a29e';

  const palette = { 'EF5': '#9d174d', 'EF4': '#dc2626', 'EF3': '#f59e0b', 'EF3+': '#f59e0b', 'EF2': '#facc15', 'EF1': '#4ade80', 'EF0': '#22d3ee', 'EFU': '#64748b' };
  return palette[text] || '#a8a29e';
}

function coordinatesToLatLngs(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  return coordinates.map((segment) => Array.isArray(segment) && segment.length >= 2 ? [segment[1], segment[0]] : null).filter(Boolean);
}

function polygonCoordinatesToLatLngs(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  return coordinates.map((ring) => {
    if (!Array.isArray(ring)) return [];
    return ring.map((point) => Array.isArray(point) && point.length >= 2 ? [point[1], point[0]] : null).filter(Boolean);
  }).filter((ring) => ring.length);
}

function applyTheme(mode) {
  state.theme = mode;
  document.body.classList.toggle('theme-light', mode === 'light');
  document.body.classList.toggle('theme-dark', mode === 'dark');
  const themeButton = document.getElementById('themeToggle');
  if (themeButton) themeButton.textContent = mode === 'dark' ? 'Light mode' : 'Dark mode';
}

function updateFilterReadouts() {
  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  const yearRangeFill = document.getElementById('yearRangeFill');

  if (yearMinInput && yearMaxInput) {
    document.getElementById('yearRangeValue').textContent = `${state.yearMin}–${state.yearMax}`;
    const min = Number(yearMinInput.min || state.yearMin);
    const max = Number(yearMaxInput.max || state.yearMax);
    const start = ((state.yearMin - min) / (Math.max(max - min, 1) || 1)) * 100;
    const end = ((state.yearMax - min) / (Math.max(max - min, 1) || 1)) * 100;
    if (yearRangeFill) {
      yearRangeFill.style.left = `${start}%`;
      yearRangeFill.style.width = `${Math.max(end - start, 0)}%`;
    }
  }
  document.getElementById('yearMinValue').textContent = String(state.yearMin);
  document.getElementById('yearMaxValue').textContent = String(state.yearMax);
  document.getElementById('magnitudeValue').textContent = document.getElementById('magnitudeMin').value;
}

function updateSpcControls() {
  const spcToggleButton = document.getElementById('spcToggle');
  const spcMultiCountyButton = document.getElementById('spcMultiCountyBtn');
  if (spcToggleButton) spcToggleButton.textContent = state.spcLayerVisible ? 'Hide SPC layer' : 'Show SPC layer';
  if (spcMultiCountyButton) {
    spcMultiCountyButton.textContent = state.spcMultiCountyOnly ? 'SPC: multi-county only' : 'SPC: all counties';
    spcMultiCountyButton.classList.toggle('active', state.spcMultiCountyOnly);
  }
}

function setStatus(message, isError = false) {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  statusEl.innerHTML = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
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
  if (row.injuries > 0 || row.deaths > 0) html += `<span>Casualties</span><strong>${row.deaths} dead, ${row.injuries} inj</strong>`;
  html += `</div>`;

  if (row.details) {
    html += `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(148, 163, 184, 0.2); font-size: 0.8rem; color: #cbd5e1; max-height: 120px; overflow-y: auto;">${row.details}</div>`;
  }
  return html;
}

function calculateStats(filtered) {
  const maxMagnitude = filtered.reduce((max, row) => Math.max(max, Number(row.magnitude) || 0), 0);
  const maxLength = filtered.reduce((max, row) => Math.max(max, Number.isFinite(Number(row.lengthMiles)) ? Number(row.lengthMiles) : 0), 0);
  return { count: filtered.length, maxMagnitude, maxLength };
}

function refreshYearBounds() {
  const rows = [...state.rows, ...state.spcRows];
  if (!rows.length) return;
  const years = rows.map((row) => Number(row.year || getYearFromDate(row.beginDate) || 0)).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (years.length) { state.yearMin = years[0]; state.yearMax = years[years.length - 1]; }
  
  const minInput = document.getElementById('yearMin');
  const maxInput = document.getElementById('yearMax');
  if (minInput) { minInput.min = String(state.yearMin); minInput.max = String(state.yearMax); minInput.value = String(state.yearMin); }
  if (maxInput) { maxInput.min = String(state.yearMin); maxInput.max = String(state.yearMax); maxInput.value = String(state.yearMax); }
  updateFilterReadouts();
}

function magnitudeColor(value) {
  const m = Number(value);
  if (!Number.isFinite(m)) return '#94a3b8';
  if (m >= 5) return '#7f1d1d';
  if (m >= 4) return '#b91c1c';
  if (m >= 3) return '#f59e0b';
  if (m >= 2) return '#facc15';
  if (m >= 1) return '#4ade80';
  return '#22d3ee';
}

async function fetchNoaaDatForTrack(record) {
  if (!record) return [];
  const candidateDates = new Set();
  for (const candidate of [record.beginDate, record.endDate, record.date, record.event_date, record.stormdate, record.damage_date]) {
    const normalized = normalizeDateString(candidate);
    if (normalized) candidateDates.add(normalized);
  }
  if (!candidateDates.size) return [];

  const layerIds = [0, 1, 2];
  const unique = new Map();
  const bbox = `${Math.min(record.beginLongitude, record.endLongitude) - 0.5},${Math.min(record.beginLatitude, record.endLatitude) - 0.5},${Math.max(record.beginLongitude, record.endLongitude) + 0.5},${Math.max(record.beginLatitude, record.endLatitude) + 0.5}`;
  
  const targetDate = normalizeDateString(firstNonEmpty(record.beginDate, record.endDate));
  let whereClause = '1%3D1';
  if (targetDate) {
    const safeDate = new Date(new Date(targetDate).getTime() + (12 * 60 * 60 * 1000)); 
    const start = new Date(safeDate.getTime() - 86400000).toISOString().split('T')[0];
    const end = new Date(safeDate.getTime() + 86400000).toISOString().split('T')[0];
    whereClause = encodeURIComponent(`stormdate >= timestamp '${start} 00:00:00' AND stormdate <= timestamp '${end} 23:59:59'`);
  }

  for (const layerId of layerIds) {
    const url = `https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/MapServer/${layerId}/query?f=geojson&where=${whereClause}&geometry=${bbox}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326`;    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) continue;
      const payload = await response.json();
      const features = Array.isArray(payload && payload.features) ? payload.features : [];

      for (const feature of features) {
        if (!feature || (!feature.properties && !feature.attributes)) continue;
        const attrs = feature.properties || feature.attributes;
        const valueSet = [attrs.stormdate, attrs.event_date, attrs.damage_date, attrs.date, attrs.begin_date];
        const matchesDate = valueSet.some((value) => {
          const normalized = normalizeDateString(value);
          return normalized && candidateDates.has(normalized);
        });

        if (!matchesDate) continue;
        const dedupeKey = `${layerId}:${attrs.objectid || JSON.stringify(feature.geometry)}`;
        if (!unique.has(dedupeKey)) unique.set(dedupeKey, feature);
      }
    } catch (error) {
      console.warn(`DAT layer ${layerId} query failed:`, error);
    }
  }
  return Array.from(unique.values());
}