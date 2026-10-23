const SPC_URL = 'https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv';
const FALLBACK_URL = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(SPC_URL);

const state = {
  rows: [],
  spcRows: [],
  filtered: [],
  map: null,
  layerGroup: null,
  datLayerGroup: null,
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
};

document.addEventListener('DOMContentLoaded', init);

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
      .sort((a, b) => (a.beginDate || '').localeCompare(b.beginDate || '') || (a.beginTime || '').localeCompare(b.beginTime || ''));

    state.spcRows = await loadSpcRows();

    if (!state.rows.length && !state.spcRows.length) {
      throw new Error('No usable tornado rows were found in the bundled CSV files or the SPC CSV.');
    }

    refreshYearBounds();
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

  state.layerGroup = L.layerGroup().addTo(state.map);
  state.datLayerGroup = L.layerGroup().addTo(state.map);
  bindControls();
  updateSpcControls();
  applyTheme('dark');
  await loadData();
}

function bindControls() {
  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  const magnitudeInput = document.getElementById('magnitudeMin');
  const resetButton = document.getElementById('resetViewBtn');
  const csvInput = document.getElementById('csvUpload');
  const datInput = document.getElementById('datUpload');
  const exportButton = document.getElementById('exportCorrections');
  const themeButton = document.getElementById('themeToggle');
  const saveButton = document.getElementById('saveChanges');
  const clearButton = document.getElementById('clearSelection');
  const spcToggleButton = document.getElementById('spcToggle');
  const spcMultiCountyButton = document.getElementById('spcMultiCountyBtn');

  if (yearMinInput && yearMaxInput) {
    yearMinInput.addEventListener('input', () => {
      const parsed = Number(yearMinInput.value);
      if (parsed > Number(yearMaxInput.value)) {
        yearMaxInput.value = parsed;
      }
      state.yearMin = parsed;
      updateFilterReadouts();
      renderFilteredData({ preserveMapView: true });
    });

    yearMaxInput.addEventListener('input', () => {
      const parsed = Number(yearMaxInput.value);
      if (parsed < Number(yearMinInput.value)) {
        yearMinInput.value = parsed;
      }
      state.yearMax = parsed;
      updateFilterReadouts();
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (magnitudeInput) {
    magnitudeInput.addEventListener('input', () => {
      state.minMagnitude = Number(magnitudeInput.value);
      updateFilterReadouts();
      renderFilteredData();
    });
  }

  if (spcToggleButton) {
    spcToggleButton.addEventListener('click', () => {
      state.spcLayerVisible = !state.spcLayerVisible;
      updateSpcControls();
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (spcMultiCountyButton) {
    spcMultiCountyButton.addEventListener('click', () => {
      state.spcMultiCountyOnly = !state.spcMultiCountyOnly;
      updateSpcControls();
      renderFilteredData({ preserveMapView: true });
    });
  }

  if (resetButton) {
    resetButton.addEventListener('click', () => {
      if (state.allBounds && state.allBounds.isValid()) {
        state.map.fitBounds(state.allBounds, { padding: [24, 24] });
      }
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

  if (exportButton) {
    exportButton.addEventListener('click', () => {
      if (!state.corrections.size) {
        setStatus('No corrections to export yet.', true);
        return;
      }

      const rows = Array.from(state.corrections.values()).map((entry) => ({
        source: entry.source,
        reportId: entry.reportId,
        beginDate: entry.beginDate,
        beginTime: entry.beginTime,
        endDate: entry.endDate,
        endTime: entry.endTime,
        beginLatitude: entry.beginLatitude,
        beginLongitude: entry.beginLongitude,
        endLatitude: entry.endLatitude,
        endLongitude: entry.endLongitude,
        magnitude: entry.magnitude,
        qcNotes: entry.qcNotes,
        originalReportId: entry.originalReportId,
      }));

      const csv = toCsv(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'tornado_qc_corrections.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${rows.length} correction row(s).`);
    });
  }

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(nextTheme);
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
        magnitude: record.magnitude,
        qcNotes: payload.qcNotes,
      });

      renderFilteredData({ preserveMapView: true });
      renderEditor();
      setStatus(`Saved updates for ${record.reportId || record.id}.`);
    });
  }

  if (clearButton) {
    clearButton.addEventListener('click', () => {
      state.selectedId = null;
      renderEditor();
      setStatus('Selection cleared.');
    });
  }
}

function applyTheme(mode) {
  state.theme = mode;
  document.body.classList.toggle('theme-light', mode === 'light');
  document.body.classList.toggle('theme-dark', mode === 'dark');

  const themeButton = document.getElementById('themeToggle');
  if (themeButton) {
    themeButton.textContent = mode === 'dark' ? 'Light mode' : 'Dark mode';
  }
}

function updateFilterReadouts() {
  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  const magnitudeInput = document.getElementById('magnitudeMin');

  document.getElementById('yearMinValue').textContent = yearMinInput.value;
  document.getElementById('yearMaxValue').textContent = yearMaxInput.value;
  document.getElementById('magnitudeValue').textContent = magnitudeInput.value;
}

function updateSpcControls() {
  const spcToggleButton = document.getElementById('spcToggle');
  const spcMultiCountyButton = document.getElementById('spcMultiCountyBtn');

  if (spcToggleButton) {
    spcToggleButton.textContent = state.spcLayerVisible ? 'Hide SPC layer' : 'Show SPC layer';
  }

  if (spcMultiCountyButton) {
    spcMultiCountyButton.textContent = state.spcMultiCountyOnly ? 'SPC: multi-county only' : 'SPC: all counties';
    spcMultiCountyButton.classList.toggle('active', state.spcMultiCountyOnly);
  }
}

function setStatus(message, isError = false) {
  const statusEl = document.getElementById('status');
  if (!statusEl) {
    return;
  }

  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
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

  const text = String(value).trim();
  if (!text || text === 'null' || text === 'NaN') {
    return null;
  }

  const clean = text.replace(/Z$/, '');

  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
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

  const hourMinute = text.match(/^(\d{4})$/);
  if (hourMinute) {
    const [, raw] = hourMinute;
    return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
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

function refreshYearBounds() {
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

  if (years.length) {
    state.yearMin = years[0];
    state.yearMax = years[years.length - 1];
  }

  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  if (yearMinInput) {
    yearMinInput.min = String(state.yearMin);
    yearMinInput.max = String(state.yearMax);
    yearMinInput.value = String(Math.min(Number(yearMinInput.value || state.yearMin), state.yearMax));
  }
  if (yearMaxInput) {
    yearMaxInput.min = String(state.yearMin);
    yearMaxInput.max = String(state.yearMax);
    yearMaxInput.value = String(Math.max(Number(yearMaxInput.value || state.yearMax), state.yearMin));
  }

  state.yearMin = Number(yearMinInput?.value || state.yearMin);
  state.yearMax = Number(yearMaxInput?.value || state.yearMax);
  updateFilterReadouts();
}

function magnitudeColor(value) {
  const magnitude = Number(value);
  if (!Number.isFinite(magnitude)) {
    return '#94a3b8';
  }

  if (magnitude >= 5) return '#7f1d1d';
  if (magnitude >= 4) return '#b91c1c';
  if (magnitude >= 3) return '#f59e0b';
  if (magnitude >= 2) return '#facc15';
  if (magnitude >= 1) return '#4ade80';
  return '#22d3ee';
}

function buildPopup(row) {
  const reportId = row.reportId || row.id || 'N/A';
  const magnitude = row.magnitude ?? row.f2 ?? row.f_2 ?? 'N/A';
  const county = firstNonEmpty(row.county, row.counties, row.state, 'N/A');
  const start = firstNonEmpty(row.beginDate, row.endDate, 'N/A');

  return `
    <div class="popup-title">${reportId}</div>
    <div class="popup-grid">
      <span>Magnitude</span><strong>${magnitude}</strong>
      <span>Date</span><strong>${start}</strong>
      <span>County</span><strong>${county}</strong>
      <span>Source</span><strong>${row.source || 'SPC'}</strong>
    </div>
  `;
}

function calculateStats(filtered) {
  const maxMagnitude = filtered.reduce((max, row) => Math.max(max, Number(row.magnitude) || 0), 0);
  const maxLength = filtered.reduce((max, row) => {
    const length = Number(row.lengthMiles || row.pathLength || row.length_mi || 0);
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
    row['Date']
  ));

  const endDate = normalizeDateString(firstNonEmpty(
    row.endDate,
    row.end_date,
    row.END_DATE,
    row.end_ymd,
    row.END_YMD,
    row['END DATE']
  ));

  const beginTime = normalizeTimeString(firstNonEmpty(
    row.beginTime,
    row.begin_time,
    row.BEGIN_TIME,
    row['BEGIN TIME'],
    row.time,
    row.TIME,
    row['Time']
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
    row['Begin Lat']
  ));

  const beginLongitude = readFloat(firstNonEmpty(
    row.beginLongitude,
    row.begin_lon,
    row.BEGIN_LON,
    row.BEGINLON,
    row.lon,
    row.longitude,
    row['Begin Lon']
  ));

  const endLatitude = readFloat(firstNonEmpty(
    row.endLatitude,
    row.end_lat,
    row.END_LAT,
    row.ENDLAT,
    row['End Lat']
  ));

  const endLongitude = readFloat(firstNonEmpty(
    row.endLongitude,
    row.end_lon,
    row.END_LON,
    row.ENDLON,
    row['End Lon']
  ));

  const invalidLatLng = (value) => value === null || value === undefined || value === 0 || Math.abs(value) >= 99900;

  if (invalidLatLng(beginLatitude) || invalidLatLng(beginLongitude) || invalidLatLng(endLatitude) || invalidLatLng(endLongitude)) {
    return null;
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
    const parsed = readFloat(candidate, null);
    if (parsed !== null) {
      magnitude = parsed;
      break;
    }
  }

  if (typeof row.magnitude === 'string' && /^(f|ef)/i.test(row.magnitude.trim())) {
    const match = row.magnitude.trim().match(/(\d+)/);
    if (match) {
      magnitude = Number(match[1]);
    }
  }

  const id = firstNonEmpty(
    row.StormEventsReportID,
    row.id,
    row.reportId,
    row.report_id,
    row.REPORT_ID,
    row['Report ID'],
    row.event_id,
    row.EVENT_ID,
    row.objectid,
    row.OBJECTID,
    `${beginDate || 'unknown'}-${beginTime || '00:00'}-${beginLatitude || 0}-${beginLongitude || 0}`
  );

  const normalized = {
    id: String(id ?? `${source}-${Math.random().toString(16).slice(2)}`),
    reportId: String(firstNonEmpty(row.reportId, row.report_id, row.REPORT_ID, id, 'UNKNOWN')),
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
    year: Number(firstNonEmpty(row.year, getYearFromDate(beginDate), getYearFromDate(endDate), 0) || 0),
    county: firstNonEmpty(row.county, row.COUNTY, row.counties, row['County'], 'Unknown'),
    state: firstNonEmpty(row.state, row.STATE, row['State'], 'Unknown'),
    lengthMiles: readFloat(firstNonEmpty(row.lengthMiles, row.length_mi, row.length_miles, row['Length (mi)'], row['Length miles'], 0), 0),
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

    const parts = line.split(/[\t,|]+/).map((part) => part.trim()).filter(Boolean);
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

  const layerIds = Array.from({ length: 16 }, (_, index) => index);
  const unique = new Map();

  for (const layerId of layerIds) {
    const url = `https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/MapServer/${layerId}/query?f=json&where=1%3D1&outFields=*&returnGeometry=true&outSR=4326`;

    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const features = Array.isArray(payload && payload.features) ? payload.features : [];

      for (const feature of features) {
        if (!feature || !feature.attributes) {
          continue;
        }

        const attrs = feature.attributes;
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

        const dedupeKey = `${layerId}:${feature.attributes.objectid || feature.attributes.OBJECTID || feature.attributes.event_id || feature.attributes.EVENT_ID || JSON.stringify(feature.geometry)}`;
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
