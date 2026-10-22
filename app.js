const SPC_URL = 'https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv';
const FALLBACK_URL = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(SPC_URL);

const state = {
  rows: [],
  filtered: [],
  map: null,
  layerGroup: null,
  polyLines: new Map(),
  allBounds: null,
  yearMin: 1950,
  yearMax: 2025,
  minMagnitude: 0,
  selectedId: null,
  corrections: new Map(),
  theme: 'dark',
  noaaDatMatches: [],
};

document.addEventListener('DOMContentLoaded', init);

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
  bindControls();
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

  yearMinInput.addEventListener('input', () => {
    const parsed = Number(yearMinInput.value);
    if (parsed > Number(yearMaxInput.value)) {
      yearMaxInput.value = parsed;
    }
    state.yearMin = parsed;
    updateFilterReadouts();
    renderFilteredData();
  });

  yearMaxInput.addEventListener('input', () => {
    const parsed = Number(yearMaxInput.value);
    if (parsed < Number(yearMinInput.value)) {
      yearMinInput.value = parsed;
    }
    state.yearMax = parsed;
    updateFilterReadouts();
    renderFilteredData();
  });

  magnitudeInput.addEventListener('input', () => {
    state.minMagnitude = Number(magnitudeInput.value);
    updateFilterReadouts();
    renderFilteredData();
  });

  resetButton.addEventListener('click', () => {
    if (state.allBounds && state.allBounds.isValid()) {
      state.map.fitBounds(state.allBounds, { padding: [24, 24] });
    }
  });

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

  themeButton.addEventListener('click', () => {
    const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
  });

  saveButton.addEventListener('click', () => {
    const record = getSelectedRecord();
    if (!record) {
      setStatus('Select a tornado segment before saving edits.', true);
      return;
    }

    const form = document.getElementById('segmentForm');
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

  clearButton.addEventListener('click', () => {
    state.selectedId = null;
    renderEditor();
    setStatus('Selection cleared.');
  });
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

async function loadBundledReportParts() {
  const fileNames = Array.from({ length: 7 }, (_, index) => `1950-2026_Tornado_Reports_part${index + 1}.csv`);
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

    if (!state.rows.length) {
      throw new Error('No usable tornado rows were found in the bundled CSV files or the SPC CSV.');
    }

    refreshYearBounds();
    renderFilteredData({ preserveMapView: true });
    setStatus(`Loaded ${state.rows.length.toLocaleString()} tornado records from the bundled report files.`);
  } catch (error) {
    console.error(error);
    setStatus(
      'Unable to load the NOAA SPC tornado CSV. Please check the internet connection or upload a local CSV/DAT file.',
      true
    );
  }
}

function refreshYearBounds() {
  const years = state.rows
    .map((row) => Number(row.year || getYearFromDate(row.beginDate)))
    .filter(Number.isFinite);

  if (!years.length) {
    return;
  }

  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  yearMinInput.min = String(minYear);
  yearMinInput.max = String(maxYear);
  yearMaxInput.min = String(minYear);
  yearMaxInput.max = String(maxYear);
  yearMinInput.value = String(Math.max(state.yearMin || minYear, minYear));
  yearMaxInput.value = String(Math.min(state.yearMax || maxYear, maxYear));

  state.yearMin = Number(yearMinInput.value);
  state.yearMax = Number(yearMaxInput.value);
  updateFilterReadouts();

  state.allBounds = L.latLngBounds(
    state.rows
      .map((row) => {
        const points = [];
        if (Number.isFinite(row.beginLatitude) && Number.isFinite(row.beginLongitude)) {
          points.push([row.beginLatitude, row.beginLongitude]);
        }
        if (Number.isFinite(row.endLatitude) && Number.isFinite(row.endLongitude)) {
          points.push([row.endLatitude, row.endLongitude]);
        }
        return points;
      })
      .filter((points) => points.length)
      .flat()
  );

  if (state.allBounds && state.allBounds.isValid()) {
    state.map.fitBounds(state.allBounds, { padding: [24, 24] });
  }
}

async function fetchCsvWithFallback() {
  const sources = [SPC_URL, FALLBACK_URL];

  for (const source of sources) {
    try {
      const response = await fetch(source, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      console.warn(`CSV fetch failed for ${source}`, error);
    }
  }

  throw new Error('Could not load SPC CSV from any source.');
}

function renderFilteredData(options = {}) {
  const { preserveMapView = false } = options;
  const filtered = state.rows.filter((row) => {
    const rowYear = Number(row.year || getYearFromDate(row.beginDate));
    return rowYear >= state.yearMin && rowYear <= state.yearMax && row.magnitude >= state.minMagnitude;
  });

  state.filtered = filtered;
  state.polyLines.clear();
  state.layerGroup.clearLayers();

  if (!filtered.length) {
    document.getElementById('trackCount').textContent = '0';
    document.getElementById('maxMagnitude').textContent = '0';
    document.getElementById('maxLength').textContent = '0 mi';
    setStatus('No tornado tracks match the selected filters.', false);
    return;
  }

  let bounds = L.latLngBounds([]);

  filtered.forEach((row) => {
    const color = magnitudeColor(row.magnitude);
    const polyline = L.polyline(
      [
        [row.beginLatitude, row.beginLongitude],
        [row.endLatitude, row.endLongitude],
      ],
      {
        color,
        weight: row.id === state.selectedId ? 6 : 3,
        opacity: row.id === state.selectedId ? 1 : 0.8,
        lineCap: 'round',
      }
    );

    polyline.bindPopup(buildPopup(row));
    polyline.on('click', async (event) => {
      L.DomEvent.stopPropagation(event);
      await handleTrackSelection(row, true);
    });
    polyline.addTo(state.layerGroup);
    state.polyLines.set(row.id, polyline);

    const startMarker = L.circleMarker([row.beginLatitude, row.beginLongitude], {
      radius: 4,
      color: '#f8fafc',
      fillColor: color,
      fillOpacity: 1,
      weight: 1,
    });
    startMarker.bindPopup(buildPopup(row));
    startMarker.on('click', async (event) => {
      L.DomEvent.stopPropagation(event);
      await handleTrackSelection(row, true);
    });
    startMarker.addTo(state.layerGroup);

    bounds.extend([[row.beginLatitude, row.beginLongitude], [row.endLatitude, row.endLongitude]]);
  });

  const stats = calculateStats(filtered);
  document.getElementById('trackCount').textContent = stats.count.toLocaleString();
  document.getElementById('maxMagnitude').textContent = String(stats.maxMagnitude);
  document.getElementById('maxLength').textContent = `${stats.maxLength.toFixed(0)} mi`;

  if (bounds.isValid() && !preserveMapView) {
    state.map.fitBounds(bounds, { padding: [30, 30] });
  }

  renderEditor();
  setStatus(`Showing ${filtered.length.toLocaleString()} tornado tracks for ${state.yearMin} to ${state.yearMax}.`, false);
}

async function handleTrackSelection(record, preserveMapView = true) {
  if (!record) {
    return;
  }

  state.selectedId = record.id;
  renderEditor();
  renderFilteredData({ preserveMapView: true });

  const matches = await fetchNoaaDatForTrack(record);
  state.noaaDatMatches = matches || [];

  if (matches && matches.length) {
    const first = matches[0];
    const normalized = normalizeArcgisDatFeature(first);
    if (normalized) {
      setStatus(
        `Selected ${record.reportId || record.id}. NOAA DAT matched ${matches.length} record(s) for ${record.beginDate || record.endDate || 'this date'}.`,
        false
      );
      return;
    }
  }

  setStatus(
    `Selected ${record.reportId || record.id}. No NOAA DAT records matched the track date in the ArcGIS service lookup.`,
    false
  );
}

async function fetchNoaaDatForTrack(record) {
  if (!record) {
    return null;
  }

  const year = Number(record.year || getYearFromDate(record.beginDate) || getYearFromDate(record.endDate));
  if (!Number.isFinite(year) || year <= 0) {
    return null;
  }

  const servicesRoot = 'https://services.dat.noaa.gov/arcgis/rest/services';
  const candidateUrls = [
    servicesRoot,
    `${servicesRoot}/StormEvents/MapServer?f=json`,
    `${servicesRoot}/nws/MapServer?f=json`,
    `${servicesRoot}/nws/tornadoes/MapServer?f=json`,
  ];

  const seen = new Set();
  for (const candidateUrl of candidateUrls) {
    if (seen.has(candidateUrl)) {
      continue;
    }
    seen.add(candidateUrl);

    try {
      const response = await fetch(candidateUrl, { cache: 'no-store' });
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const serviceNames = [];

      if (Array.isArray(payload?.services)) {
        for (const service of payload.services) {
          const name = String(service?.name || service?.serviceName || '').trim();
          if (!name) {
            continue;
          }
          if (/(tornado|storm|event|report)/i.test(name)) {
            serviceNames.push(name);
          }
        }
      }

      if (candidateUrl === servicesRoot && !serviceNames.length) {
        const fallback = ['StormEvents', 'nws', 'tornadoes', 'weather'];
        serviceNames.push(...fallback.filter((name) => name));
      }

      const urls = serviceNames.map((name) => `${servicesRoot}/${name}/MapServer/0/query?where=1=1&outFields=*&f=json`);
      if (candidateUrl.includes('/MapServer?f=json')) {
        urls.push(candidateUrl.replace(/\?f=json$/i, '/0/query?where=1=1&outFields=*&f=json'));
      }

      for (const url of urls) {
        const matches = await queryNoaaDatService(url, record, year);
        if (matches && matches.length) {
          return matches;
        }
      }
    } catch (error) {
      console.warn('NOAA DAT service lookup failed:', error);
    }
  }

  return null;
}

async function queryNoaaDatService(serviceUrl, record, targetYear) {
  if (!serviceUrl || !record) {
    return [];
  }

  const beginDate = normalizeDateString(record.beginDate || record.endDate);
  const endDate = normalizeDateString(record.endDate || record.beginDate);
  const dateClauses = [];

  if (beginDate) {
    dateClauses.push(`(DATE >= '${beginDate}' OR BEGIN_DATE >= '${beginDate}' OR EVENT_DATE >= '${beginDate}')`);
  }
  if (endDate) {
    dateClauses.push(`(DATE <= '${endDate}' OR BEGIN_DATE <= '${endDate}' OR EVENT_DATE <= '${endDate}')`);
  }

  const where = dateClauses.length ? dateClauses.join(' AND ') : `YEAR = ${targetYear}`;
  const serviceEndpoint = serviceUrl.replace(/\/query\??.*$/i, '');
  const queryUrl = `${serviceEndpoint}/query?where=${encodeURIComponent(where)}&outFields=*&f=json&resultRecordCount=50`;

  try {
    const response = await fetch(queryUrl, { cache: 'no-store' });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const features = Array.isArray(payload?.features) ? payload.features : [];
    if (!features.length) {
      return [];
    }

    const filtered = features.filter((feature) => {
      const attrs = feature?.attributes || {};
      const dateValues = [
        attrs.DATE,
        attrs.BEGIN_DATE,
        attrs.END_DATE,
        attrs.EVENT_DATE,
        attrs.date,
        attrs.begin_date,
        attrs.end_date,
        attrs.event_date,
      ]
        .filter((value) => value !== undefined && value !== null && value !== '')
        .map((value) => String(value));

      if (!dateValues.length) {
        return true;
      }

      const normalized = dateValues.map((value) => normalizeDateString(value));
      return normalized.some((value) => value && value.slice(0, 4) === String(targetYear));
    });

    return filtered.length ? filtered : features.slice(0, 5);
  } catch (error) {
    console.warn('ArcGIS NOAA DAT query failed:', error);
    return [];
  }
}

function normalizeArcgisDatFeature(feature) {
  const attrs = feature?.attributes || {};
  const record = {
    id: `NOAA-DAT-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    reportId: firstNonEmpty(attrs.REPORT_ID, attrs.REPORTID, attrs.OBJECTID, attrs.ID, `DAT-${Date.now()}`),
    source: 'NOAA DAT',
    year: Number(firstNonEmpty(attrs.YEAR, attrs.year, attrs.DATE, attrs.EVENT_DATE, String(new Date().getFullYear()))) || new Date().getFullYear(),
    beginDate: normalizeDateString(firstNonEmpty(attrs.BEGIN_DATE, attrs.DATE, attrs.EVENT_DATE, attrs.START_DATE)),
    beginTime: normalizeTimeString(firstNonEmpty(attrs.BEGIN_TIME, attrs.TIME, attrs.START_TIME)),
    endDate: normalizeDateString(firstNonEmpty(attrs.END_DATE, attrs.DATE, attrs.EVENT_DATE, attrs.START_DATE)),
    endTime: normalizeTimeString(firstNonEmpty(attrs.END_TIME, attrs.TIME, attrs.START_TIME)),
    beginLatitude: readFloat(attrs, ['BEGIN_LAT', 'BEGINLAT', 'LAT', 'BEGIN_LATITUDE', 'START_LAT', 'latitude']),
    beginLongitude: readFloat(attrs, ['BEGIN_LON', 'BEGINLON', 'LON', 'BEGIN_LONGITUDE', 'START_LON', 'longitude']),
    endLatitude: readFloat(attrs, ['END_LAT', 'ENDLAT', 'LAT', 'END_LATITUDE', 'START_LAT']),
    endLongitude: readFloat(attrs, ['END_LON', 'ENDLON', 'LON', 'END_LONGITUDE', 'START_LON']),
    magnitude: normalizeMagnitude(firstNonEmpty(attrs.MAG, attrs.MAGNITUDE, attrs.F_SCALE, attrs.EF_SCALE, '0')),
    qcNotes: firstNonEmpty(attrs.NOTES, attrs.COMMENT, attrs.NOTE, '') || 'Retrieved from NOAA DAT ArcGIS service.',
    sourceRecord: attrs,
  };

  if (!Number.isFinite(record.beginLatitude) || !Number.isFinite(record.beginLongitude)) {
    return null;
  }

  if (!Number.isFinite(record.endLatitude)) {
    record.endLatitude = record.beginLatitude;
  }
  if (!Number.isFinite(record.endLongitude)) {
    record.endLongitude = record.beginLongitude;
  }

  return record;
}

function renderEditor() {
  const record = getSelectedRecord();
  const form = document.getElementById('segmentForm');
  const emptyMessage = document.getElementById('selectionEmpty');

  if (!record) {
    form.classList.add('hidden');
    emptyMessage.classList.remove('hidden');
    return;
  }

  emptyMessage.classList.add('hidden');
  form.classList.remove('hidden');

  document.getElementById('selectionLabel').textContent = `${record.reportId || record.id} • ${record.source}`;
  document.getElementById('reportId').value = record.reportId || record.id;
  document.getElementById('beginDate').value = record.beginDate || '';
  document.getElementById('beginTime').value = record.beginTime || '';
  document.getElementById('endDate').value = record.endDate || record.beginDate || '';
  document.getElementById('endTime').value = record.endTime || record.beginTime || '';
  document.getElementById('beginLat').value = Number.isFinite(record.beginLatitude) ? record.beginLatitude : '';
  document.getElementById('beginLon').value = Number.isFinite(record.beginLongitude) ? record.beginLongitude : '';
  document.getElementById('endLat').value = Number.isFinite(record.endLatitude) ? record.endLatitude : '';
  document.getElementById('endLon').value = Number.isFinite(record.endLongitude) ? record.endLongitude : '';
  document.getElementById('qcNotes').value = record.qcNotes || '';
}

function getSelectedRecord() {
  return state.rows.find((row) => row.id === state.selectedId) || null;
}

function calculateStats(rows) {
  const maxMagnitude = rows.reduce((max, row) => Math.max(max, row.magnitude), 0);
  const maxLength = rows.reduce((max, row) => Math.max(max, row.lengthMiles || 0), 0);

  return {
    count: rows.length,
    maxMagnitude,
    maxLength,
  };
}

function buildPopup(row) {
  return `
    <div class="popup-title">${row.reportId || row.id}</div>
    <div class="popup-grid">
      <span>Source</span><strong>${row.source}</strong>
      <span>Year</span><strong>${row.year}</strong>
      <span>State</span><strong>${row.state || 'Unknown'}</strong>
      <span>Begins</span><strong>${Number(row.beginLatitude).toFixed(2)}, ${Number(row.beginLongitude).toFixed(2)}</strong>
      <span>Ends</span><strong>${Number(row.endLatitude).toFixed(2)}, ${Number(row.endLongitude).toFixed(2)}</strong>
      <span>Magnitude</span><strong>F${row.magnitude || 0}</strong>
      <span>Length</span><strong>${row.lengthMiles ? row.lengthMiles.toFixed(1) : '0.0'} mi</strong>
    </div>
  `;
}

function magnitudeColor(magnitude) {
  const palette = {
    0: '#60a5fa',
    1: '#34d399',
    2: '#fbbf24',
    3: '#f97316',
    4: '#ef4444',
    5: '#a855f7',
  };

  return palette[Math.max(0, Math.min(5, Number(magnitude) || 0))] || '#60a5fa';
}

function setStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function firstNonEmpty() {
  for (const value of arguments) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const text = String(value).trim();
    if (text && text.toLowerCase() !== 'nan' && text.toLowerCase() !== 'null') {
      return text;
    }
  }
  return '';
}

function readFloat(obj, keys) {
  for (const key of keys) {
    const value = obj && obj[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const parsed = Number.parseFloat(String(value).replace(/,/g, '').trim());
    if (!Number.isFinite(parsed)) {
      continue;
    }

    if (parsed === 0 || parsed === -99900 || Math.abs(parsed) >= 99900) {
      return Number.NaN;
    }

    return parsed;
  }

  return Number.NaN;
}

function normalizeRow(row, source = 'CSV') {
  if (!row) {
    return null;
  }

  const reportId = firstNonEmpty(
    row.stormEventsReportID,
    row.reportId,
    row.report_id,
    row.stormEventID,
    row.id,
    row.om,
    row.oneTorID,
    row.tornadoreportid,
    row.event_id
  );

  const beginDate = firstNonEmpty(
    row.beginDate,
    row.begin_date,
    row.date,
    row.startDate,
    row.beginDateTxt,
    row.beginTimestamp,
    row.begin_timestamp
  );
  const beginTime = firstNonEmpty(row.beginTime, row.begin_time, row.time, row.startTime, row.start_time);
  const endDate = firstNonEmpty(row.endDate, row.end_date, row.edat, row.endDateTxt, row.endTimestamp, row.end_timestamp);
  const endTime = firstNonEmpty(row.endTime, row.end_time, row.etime, row.endTimeTxt);

  const beginLatitude = readFloat(row, ['beginLatitude', 'begin_lat', 'slat', 'startLat', 'lat']);
  const beginLongitude = readFloat(row, ['beginLongitude', 'begin_lon', 'slon', 'startLon', 'lon']);
  const endLatitude = readFloat(row, ['endLatitude', 'end_lat', 'elat', 'endLat']);
  const endLongitude = readFloat(row, ['endLongitude', 'end_lon', 'elon', 'endLon']);

  if (!Number.isFinite(beginLatitude) || !Number.isFinite(beginLongitude) || !Number.isFinite(endLatitude) || !Number.isFinite(endLongitude)) {
    return null;
  }

  const magnitude = normalizeMagnitude(firstNonEmpty(row.mag, row.m, row.fscale, row.efscale, row.magnitude));
  const year = parseYear(row, beginDate, endDate, row.yr, row.year);
  const lengthMiles = readFloat(row, ['len', 'length', 'lengthMiles', 'pathLengthMi', 'pathlength']) || 0;

  const record = {
    id: `${source}-${String(reportId || `${year}-${Math.random().toString(16).slice(2)}`)}`,
    reportId: String(reportId || `${year}-unknown`),
    source,
    year,
    beginDate: normalizeDateString(beginDate),
    beginTime: normalizeTimeString(beginTime),
    endDate: normalizeDateString(endDate || beginDate),
    endTime: normalizeTimeString(endTime || beginTime),
    beginLatitude,
    beginLongitude,
    endLatitude,
    endLongitude,
    magnitude,
    lengthMiles,
    state: firstNonEmpty(row.st, row.state, row.stateName, row.state_name, 'Unknown'),
    county: firstNonEmpty(row.cou, row.county, row.countyName, row.county_name, ''),
    qcNotes: firstNonEmpty(row.qcNotes, row.notes, row.qc_note, row.comment, ''),
    sourceRecord: row,
  };

  if (!Number.isFinite(record.year)) {
    record.year = getYearFromDate(record.beginDate);
  }
  return record;
}

function parseDatRecords(text) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let current = {};

  const flushCurrent = () => {
    if (!Object.keys(current).length) {
      return;
    }
    const normalized = normalizeDatRecord(current);
    if (normalized) {
      records.push(normalized);
    }
    current = {};
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_\-\s]+?)\s*[:=]\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim().toLowerCase();
      const value = kvMatch[2].trim();
      current[key] = value;
      continue;
    }

    const possibleDelim = line.includes('\t') ? '\t' : line.includes('|') ? '|' : line.includes(',') ? ',' : null;
    if (possibleDelim) {
      const parts = line.split(possibleDelim).map((part) => part.trim());
      if (parts.length >= 4) {
        const [date, time, lat, lon, ...rest] = parts;
        current.date = current.date || date;
        current.time = current.time || time;
        current.lat = current.lat || lat;
        current.lon = current.lon || lon;
        if (rest.length) {
          current.notes = current.notes || rest.join(' ');
        }
      }
      continue;
    }

    if (line === '---' || line === 'END') {
      flushCurrent();
    }
  }

  flushCurrent();
  return records;
}

function normalizeDatRecord(obj) {
  const normalized = {
    reportId: firstNonEmpty(
      obj.report_id,
      obj.reportid,
      obj.storm_id,
      obj.stormid,
      obj.event_id,
      obj.id,
      `DAT-${Date.now()}-${Math.random().toString(16).slice(2)}`
    ),
    source: 'DAT',
    beginDate: normalizeDateString(firstNonEmpty(obj.date, obj.begin_date, obj.start_date)),
    beginTime: normalizeTimeString(firstNonEmpty(obj.time, obj.begin_time, obj.start_time)),
    endDate: normalizeDateString(firstNonEmpty(obj.end_date, obj.date, obj.begin_date, obj.start_date)),
    endTime: normalizeTimeString(firstNonEmpty(obj.end_time, obj.time, obj.endTime, obj.begin_time, obj.start_time)),
    beginLatitude: readFloat(obj, ['lat', 'latitude', 'begin_lat', 'start_lat']),
    beginLongitude: readFloat(obj, ['lon', 'longitude', 'begin_lon', 'start_lon']),
    endLatitude: readFloat(obj, ['end_lat', 'endlatitude', 'end_latitude', 'lat']),
    endLongitude: readFloat(obj, ['end_lon', 'endlongitude', 'end_longitude', 'lon']),
    qcNotes: firstNonEmpty(obj.notes, obj.comment, obj.note, obj.qc_note, ''),
    magnitude: normalizeMagnitude(firstNonEmpty(obj.magnitude, obj.mag, obj.rating, obj.damage, '0')),
  };

  if (!Number.isFinite(normalized.beginLatitude) || !Number.isFinite(normalized.beginLongitude)) {
    return null;
  }

  const year = getYearFromDate(normalized.beginDate) || new Date().getFullYear();
  normalized.id = `DAT-${normalized.reportId}-${year}`;
  normalized.reportId = String(normalized.reportId);
  normalized.year = year;
  normalized.sourceRecord = obj;

  if (!Number.isFinite(normalized.endLatitude)) {
    normalized.endLatitude = normalized.beginLatitude;
  }
  if (!Number.isFinite(normalized.endLongitude)) {
    normalized.endLongitude = normalized.beginLongitude;
  }
  if (!normalized.beginDate) {
    normalized.beginDate = `${year}-01-01`;
  }

  return normalized;
}

function normalizeMagnitude(value) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }

  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(5, Math.round(numeric)));
}

function parseYear(row, beginDate, endDate, altYear, fallbackYear) {
  const candidate = firstNonEmpty(altYear, fallbackYear, beginDate, endDate);
  if (!candidate) {
    return 0;
  }

  const num = Number.parseInt(candidate, 10);
  if (Number.isFinite(num)) {
    return num;
  }

  const date = new Date(candidate);
  if (!Number.isNaN(date.getTime())) {
    return date.getFullYear();
  }

  const dateText = normalizeDateString(candidate);
  if (!dateText) {
    return 0;
  }

  const yearFromDate = Number.parseInt(dateText.slice(0, 4), 10);
  return Number.isFinite(yearFromDate) ? yearFromDate : 0;
}

function normalizeDateString(value) {
  const text = firstNonEmpty(value);
  if (!text) {
    return '';
  }

  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (/^\d{8}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  const matches = cleaned.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (matches) {
    return `${matches[1]}-${String(matches[2]).padStart(2, '0')}-${String(matches[3]).padStart(2, '0')}`;
  }

  return cleaned;
}

function normalizeTimeString(value) {
  const text = firstNonEmpty(value);
  if (!text) {
    return '';
  }

  const cleaned = String(text).trim();
  const matches = cleaned.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (matches) {
    return `${String(matches[1]).padStart(2, '0')}:${String(matches[2]).padStart(2, '0')}`;
  }

  const compact = cleaned.replace(/[^\d]/g, '');
  if (compact.length === 4) {
    return `${compact.slice(0, 2)}:${compact.slice(2, 4)}`;
  }

  return cleaned;
}

function getYearFromDate(dateText) {
  const text = normalizeDateString(dateText);
  if (!text) {
    return 0;
  }
  const year = Number.parseInt(text.slice(0, 4), 10);
  return Number.isFinite(year) ? year : 0;
}

function toCsv(rows) {
  if (!rows.length) {
    return '';
  }

  const headers = [
    'source',
    'reportId',
    'beginDate',
    'beginTime',
    'endDate',
    'endTime',
    'beginLatitude',
    'beginLongitude',
    'endLatitude',
    'endLongitude',
    'magnitude',
    'qcNotes',
    'originalReportId',
  ];

  const escapeValue = (value) => {
    const text = value === undefined || value === null ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map((header) => escapeValue(row[header] ?? ''));
    lines.push(values.join(','));
  }

  return lines.join('\n');
}