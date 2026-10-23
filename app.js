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

  const updateYearRange = () => {
    const min = Number(yearMinInput.value);
    const max = Number(yearMaxInput.value);

    if (min > max) {
      if (document.activeElement === yearMinInput) {
        yearMaxInput.value = String(min);
      } else {
        yearMinInput.value = String(max);
      }
    }

    const rangeMin = Number(yearMinInput.value);
    const rangeMax = Number(yearMaxInput.value);
    state.yearMin = rangeMin;
    state.yearMax = rangeMax;
    updateFilterReadouts();
    renderFilteredData({ preserveMapView: true });
  };

  yearMinInput.addEventListener('input', updateYearRange);
  yearMaxInput.addEventListener('input', updateYearRange);
  updateFilterReadouts();

  magnitudeInput.addEventListener('input', () => {
    state.minMagnitude = Number(magnitudeInput.value);
    updateFilterReadouts();
    renderFilteredData({ preserveMapView: true });
  });

  spcToggleButton.addEventListener('click', () => {
    state.spcLayerVisible = !state.spcLayerVisible;
    updateSpcControls();
    renderFilteredData({ preserveMapView: true });
  });

  spcMultiCountyButton.addEventListener('click', () => {
    state.spcMultiCountyOnly = !state.spcMultiCountyOnly;
    updateSpcControls();
    renderFilteredData({ preserveMapView: true });
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

  if (yearMinInput && document.getElementById('yearMinValue')) {
    document.getElementById('yearMinValue').textContent = yearMinInput.value;
  }
  if (yearMaxInput && document.getElementById('yearMaxValue')) {
    document.getElementById('yearMaxValue').textContent = yearMaxInput.value;
  }
  if (yearMinInput && yearMaxInput && document.getElementById('yearRangeValue')) {
    document.getElementById('yearRangeValue').textContent = `${yearMinInput.value}–${yearMaxInput.value}`;
  }
  if (magnitudeInput && document.getElementById('magnitudeValue')) {
    document.getElementById('magnitudeValue').textContent = magnitudeInput.value;
  }
  updateRangeFill();
}

function updateRangeFill() {
  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  const fill = document.getElementById('yearRangeFill');
  if (!yearMinInput || !yearMaxInput || !fill) {
    return;
  }

  const min = Number(yearMinInput.min || 1950);
  const max = Number(yearMaxInput.max || 2025);
  const range = Math.max(1, max - min);
  const left = ((Number(yearMinInput.value) - min) / range) * 100;
  const right = ((Number(yearMaxInput.value) - min) / range) * 100;

  fill.style.left = `${left}%`;
  fill.style.width = `${Math.max(0, right - left)}%`;
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
    console.warn('Unable to load SPC layer:', error);
    return [];
  }
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
  state.polyLines.clear();
  state.layerGroup.clearLayers();
  clearDatLayer();

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
        dashArray: isSpc ? '8 8' : null,
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
      color: isSpc ? '#f8fafc' : '#f8fafc',
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

function normalizeDateString(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const raw = String(value).trim();
  if (!raw) {
    return '';
  }

  const isoMatch = raw.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoMatch) {
    return raw;
  }

  const compactMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    const [, year, month, day] = compactMatch;
    return `${year}-${month}-${day}`;
  }

  const combinedMatch = raw.match(/^(\d{4})(\d{2})(\d{2})[-_ ](\d{2})(\d{2})$/);
  if (combinedMatch) {
    const [, year, month, day, hour, minute] = combinedMatch;
    return `${year}-${month}-${day}`;
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    const fullYear = year.length === 2 ? `19${year}` : year;
    return `${fullYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const shortDate = new Date(raw);
  if (!Number.isNaN(shortDate.getTime())) {
    return shortDate.toISOString().slice(0, 10);
  }

  return raw;
}

function normalizeTimeString(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const raw = String(value).trim();
  if (!raw) {
    return '';
  }

  const combinedMatch = raw.match(/^(\d{4})(\d{2})(\d{2})[-_ ](\d{2})(\d{2})$/);
  if (combinedMatch) {
    const [, , , , hour, minute] = combinedMatch;
    return `${hour}:${minute}`;
  }

  const compactMatch = raw.match(/^(\d{4})$/);
  if (compactMatch) {
    const [, digits] = compactMatch;
    const hour = digits.slice(0, 2);
    const minute = digits.slice(2, 4);
    return `${hour}:${minute}`;
  }

  const timeMatch = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:AM|PM)?$/i);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = String(timeMatch[2]).padStart(2, '0');
    const normalizedHour = hour % 24;
    return `${String(normalizedHour).padStart(2, '0')}:${minute}`;
  }

  const isoTime = raw.match(/T(\d{2}):(\d{2})/);
  if (isoTime) {
    return `${isoTime[1]}:${isoTime[2]}`;
  }

  return raw.slice(0, 5);
}

function readFloat(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const cleaned = String(value).trim().replace(/,/g, '').replace(/[^0-9.+\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '+' || cleaned === '.') {
    return null;
  }

  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDatRecords(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    return [];
  }

  const first = lines[0];
  const hasHeader = /begin|end|lat|lon|date|time|report/i.test(first);
  if (hasHeader) {
    const rows = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => String(header).trim(),
    }).data || [];
    return rows
      .map((row) => normalizeRow(row, 'DAT'))
      .filter(Boolean);
  }

  return [];
}

function setStatus(message, isError = false) {
  const status = document.getElementById('status');
  if (!status) {
    return;
  }

  status.textContent = message || '';
  status.classList.toggle('error', Boolean(isError));
}

function toCsv(rows) {
  if (!rows || !rows.length) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const csvRows = [headers.join(',')];
  for (const row of rows) {
    csvRows.push(
      headers
        .map((key) => {
          const value = row[key] ?? '';
          const text = String(value).replace(/"/g, '""');
          return `"${text}"`;
        })
        .join(',')
    );
  }
  return csvRows.join('\n');
}

function getSelectedRecord() {
  if (!state.selectedId) {
    return null;
  }

  const candidate = state.filtered.find((row) => row.id === state.selectedId);
  if (candidate) {
    return candidate;
  }

  return state.rows.find((row) => row.id === state.selectedId) || null;
}

function renderEditor() {
  const form = document.getElementById('segmentForm');
  const emptyState = document.getElementById('selectionEmpty');
  const selected = getSelectedRecord();

  if (!form || !emptyState) {
    return;
  }

  if (!selected) {
    form.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  form.classList.remove('hidden');
  emptyState.classList.add('hidden');

  const selectionLabel = document.getElementById('selectionLabel');
  if (selectionLabel) {
    selectionLabel.textContent = `${selected.reportId || selected.id || 'Report'} • M${selected.magnitude ?? 'N/A'}`;
  }

  const fields = [
    ['reportId', selected.reportId || selected.id || ''],
    ['beginDate', selected.beginDate || ''],
    ['beginTime', selected.beginTime || ''],
    ['endDate', selected.endDate || ''],
    ['endTime', selected.endTime || ''],
    ['beginLat', selected.beginLatitude ?? ''],
    ['beginLon', selected.beginLongitude ?? ''],
    ['endLat', selected.endLatitude ?? ''],
    ['endLon', selected.endLongitude ?? ''],
    ['qcNotes', selected.qcNotes || ''],
  ];

  for (const [id, value] of fields) {
    const input = document.getElementById(id);
    if (input) {
      input.value = value ?? '';
    }
  }
}

function calculateStats(filtered) {
  const count = filtered.length;
  const maxMagnitude = filtered.reduce((max, row) => Math.max(max, Number(row.magnitude) || 0), 0);
  const maxLength = filtered.reduce((max, row) => {
    const start = [row.beginLatitude, row.beginLongitude];
    const end = [row.endLatitude, row.endLongitude];
    if (!start.every(Number.isFinite) || !end.every(Number.isFinite)) {
      return max;
    }
    const distanceMiles = Math.hypot(
      (end[0] - start[0]) * 69,
      (end[1] - start[1]) * 54.6
    );
    return Math.max(max, distanceMiles);
  }, 0);

  return { count, maxMagnitude, maxLength };
}

function magnitudeColor(value) {
  const magnitude = Number(value);
  if (!Number.isFinite(magnitude)) {
    return '#94a3b8';
  }

  const palette = {
    0: '#a7f3d0',
    1: '#60a5fa',
    2: '#facc15',
    3: '#f59e0b',
    4: '#ef4444',
    5: '#7c3aed',
  };

  return palette[Math.min(5, Math.max(0, Math.round(magnitude)))] || '#94a3b8';
}

function buildPopup(row) {
  const title = row.reportId || row.id || 'Track';
  const magnitude = row.magnitude ?? 'N/A';
  const source = row.source || 'Report';

  return `
    <div class="popup-title">${title}</div>
    <div class="popup-grid">
      <span>Source</span><strong>${source}</strong>
      <span>Magnitude</span><strong>${magnitude}</strong>
      <span>Begin</span><strong>${row.beginDate || 'N/A'} ${row.beginTime || ''}</strong>
      <span>End</span><strong>${row.endDate || 'N/A'} ${row.endTime || ''}</strong>
      <span>Start</span><strong>${row.beginLatitude ?? 'N/A'}, ${row.beginLongitude ?? 'N/A'}</strong>
      <span>End pt</span><strong>${row.endLatitude ?? 'N/A'}, ${row.endLongitude ?? 'N/A'}</strong>
    </div>
  `;
}

function refreshYearBounds() {
  const allYears = [...state.rows, ...state.spcRows]
    .map((row) => Number(row.year || getYearFromDate(row.beginDate) || getYearFromDate(row.endDate)))
    .filter(Number.isFinite);

  if (!allYears.length) {
    state.yearMin = 1950;
    state.yearMax = 2025;
  } else {
    state.yearMin = Math.min(...allYears);
    state.yearMax = Math.max(...allYears);
  }

  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  if (yearMinInput && yearMaxInput) {
    yearMinInput.min = String(state.yearMin);
    yearMinInput.max = String(state.yearMax);
    yearMaxInput.min = String(state.yearMin);
    yearMaxInput.max = String(state.yearMax);
    yearMinInput.value = String(state.yearMin);
    yearMaxInput.value = String(state.yearMax);
  }

  updateFilterReadouts();
}

function getYearFromDate(value) {
  if (!value) {
    return null;
  }

  const normalized = normalizeDateString(value);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(\d{4})-/);
  return match ? Number(match[1]) : null;
}

function normalizeRow(row, source = 'CSV') {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const beginDate = normalizeDateString(
    row.beginDate ?? row.BEGIN_DATE ?? row['BEGIN DATE'] ?? row.BEGINDATE ?? row.date ?? row.DATE ?? row.eventDate ?? row['EVENT_DATE']
  );
  const endDate = normalizeDateString(
    row.endDate ?? row.END_DATE ?? row['END DATE'] ?? row.ENDDATE ?? row.end_date ?? row['END_DATE'] ?? row.endDateRaw
  );
  const beginTime = normalizeTimeString(
    row.beginTime ?? row.BEGIN_TIME ?? row['BEGIN TIME'] ?? row.BEGINTIME ?? row.time ?? row.TIME
  );
  const endTime = normalizeTimeString(
    row.endTime ?? row.END_TIME ?? row['END TIME'] ?? row.ENDTIME ?? row.end_time ?? row['END_TIME']
  );

  const beginLatitude = readFloat(
    row.beginLatitude ?? row.BEGIN_LAT ?? row['BEGIN LAT'] ?? row.begin_lat ?? row.lat ?? row['LAT'] ?? row.startLat
  );
  const beginLongitude = readFloat(
    row.beginLongitude ?? row.BEGIN_LON ?? row['BEGIN LON'] ?? row.begin_lon ?? row.lon ?? row['LON'] ?? row.startLon
  );
  const endLatitude = readFloat(
    row.endLatitude ?? row.END_LAT ?? row['END LAT'] ?? row.end_lat ?? row.endLat ?? row['ENDLAT']
  );
  const endLongitude = readFloat(
    row.endLongitude ?? row.END_LON ?? row['END LON'] ?? row.end_lon ?? row.endLon ?? row['ENDLON']
  );

  const magnitude = readFloat(
    row.magnitude ?? row.MAGNITUDE ?? row['MAGNITUDE'] ?? row.f_scale ?? row['F SCALE'] ?? row['F_SCALE'] ?? row.f ?? row.F ?? row.ef_scale ?? row.EF_SCALE
  );

  if (beginLatitude === null || beginLongitude === null || endLatitude === null || endLongitude === null) {
    if ((beginLatitude === null && beginLongitude === null && endLatitude === null && endLongitude === null) || (Math.abs(beginLatitude ?? 0) < 1e-6 && Math.abs(beginLongitude ?? 0) < 1e-6 && Math.abs(endLatitude ?? 0) < 1e-6 && Math.abs(endLongitude ?? 0) < 1e-6)) {
      return null;
    }
  }

  if (beginLatitude !== null && Math.abs(beginLatitude) < 1e-6) {
    return null;
  }
  if (beginLongitude !== null && Math.abs(beginLongitude) < 1e-6) {
    return null;
  }
  if (beginLatitude !== null && beginLatitude === 0) {
    return null;
  }
  if (beginLongitude !== null && beginLongitude === 0) {
    return null;
  }
  if (beginLatitude !== null && beginLatitude < -99900) {
    return null;
  }
  if (beginLongitude !== null && beginLongitude < -99900) {
    return null;
  }

  const validLat = (() => {
    if (beginLatitude === null || beginLatitude === undefined) return false;
    if (Math.abs(beginLatitude) > 90) return false;
    if (Math.abs(beginLatitude) < 1e-6) return false;
    return true;
  })();

  const validLon = (() => {
    if (beginLongitude === null || beginLongitude === undefined) return false;
    if (Math.abs(beginLongitude) > 180) return false;
    if (Math.abs(beginLongitude) < 1e-6) return false;
    return true;
  })();

  if (!validLat || !validLon) {
    return null;
  }

  const normalized = {
    id: `${source}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    source,
    reportId: row.reportId ?? row.REPORT_ID ?? row['REPORT ID'] ?? row['REPORTID'] ?? row.id ?? row.ID ?? '',
    beginDate: beginDate || endDate || '',
    beginTime: beginTime || '',
    endDate: endDate || beginDate || '',
    endTime: endTime || beginTime || '',
    beginLatitude: beginLatitude ?? null,
    beginLongitude: beginLongitude ?? null,
    endLatitude: endLatitude ?? beginLatitude ?? null,
    endLongitude: endLongitude ?? beginLongitude ?? null,
    magnitude: magnitude ?? 0,
    year: Number(row.year ?? row.YEAR ?? getYearFromDate(beginDate || endDate) ?? 0),
    qcNotes: row.qcNotes ?? row['QC NOTES'] ?? '',
    f2: row.f2 ?? row['F2'] ?? row.f_2 ?? row['F_2'] ?? row.multiCounty ?? row.multi_county ?? null,
    county: row.county ?? row.COUNTY ?? row.counties ?? row.COUNTIES ?? '',
    stateName: row.state ?? row.STATE ?? '',
  };

  if (!normalized.reportId) {
    normalized.reportId = `${normalized.beginDate || 'unknown'}-${normalized.beginLatitude ?? 'lat'}-${normalized.beginLongitude ?? 'lon'}`;
  }

  if (normalized.beginDate) {
    normalized.year = Number(getYearFromDate(normalized.beginDate) || normalized.year || 0);
  }

  return normalized;
}

function fetchNoaaDatForTrack(record) {
  if (!record) {
    return [];
  }

  const dateValue = record.beginDate || record.endDate;
  if (!dateValue) {
    return [];
  }

  const rawDate = normalizeDateString(dateValue);
  if (!rawDate) {
    return [];
  }

  const startDate = new Date(`${rawDate}T00:00:00Z`);
  const endDate = new Date(`${rawDate}T23:59:59Z`);
  const startIso = startDate.toISOString().slice(0, 19).replace('T', ' ');
  const endIso = endDate.toISOString().slice(0, 19).replace('T', ' ');

  const where = `stormdate >= timestamp '${startIso}' AND stormdate <= timestamp '${endIso}'`;
  return queryNoaaDatService(where);
}

function queryNoaaDatService(whereClause) {
  const url = new URL('https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/MapServer/0/query');
  url.searchParams.set('f', 'json');
  url.searchParams.set('where', whereClause || '1=1');
  url.searchParams.set('outFields', '*');
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('resultOffset', '0');
  url.searchParams.set('resultRecordCount', '200');

  return fetch(url.toString(), { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`NOAA DAT query failed: ${response.status}`);
      }
      return response.json();
    })
    .then((payload) => {
      const features = Array.isArray(payload?.features) ? payload.features : [];
      return features;
    })
    .catch((error) => {
      console.warn('NOAA DAT lookup failed:', error);
      return [];
    });
}

function normalizeArcgisDatFeature(feature) {
  if (!feature || !feature.attributes) {
    return null;
  }

  const attributes = feature.attributes;
  const geometry = feature.geometry || {};
  const lat = Number(attributes.lat ?? attributes.LAT ?? attributes.latitude ?? geometry.y ?? null);
  const lon = Number(attributes.lon ?? attributes.LON ?? attributes.longitude ?? geometry.x ?? null);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    eventId: attributes.event_id ?? attributes.EVENT_ID ?? attributes.eventid ?? null,
    efScale: attributes.efscale ?? attributes.EFSCALE ?? attributes.ef_scale ?? null,
    office: attributes.office ?? attributes.OFFICE ?? null,
    damageText: attributes.damage_txt ?? attributes.DAMAGE_TXT ?? null,
    stormDate: attributes.stormdate ?? attributes.STORMDATE ?? null,
    lat,
    lon,
  };
}

function isMultiCountyRow(row) {
  if (!row) {
    return false;
  }

  const candidateValues = [
    row.f2,
    row.f_2,
    row.multiCounty,
    row.multi_county,
    row.multiCounties,
    row.multi_counties,
    row.multiSegment,
    row.multi_segment,
    row.multiCountyCount,
    row.countyCount,
  ];

  for (const value of candidateValues) {
    const numeric = Number.parseFloat(String(value ?? '').replace(/,/g, '').trim());
    if (Number.isFinite(numeric) && numeric !== 0) {
      return true;
    }
  }

  const countyText = String(row.county || row.counties || row.state || '').trim();
  return /\band\b|\b&\b|\,/.test(countyText) && countyText.length > 3;
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
  renderDatPointsOnMap(matches || []);

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

function clearDatLayer() {
  if (state.datLayerGroup) {
    state.datLayerGroup.clearLayers();
  }
  state.noaaDatMatches = [];
}

function renderDatPointsOnMap(features) {
  clearDatLayer();
  if (!features || !features.length || !state.datLayerGroup) {
    return;
  }

  const markers = features
    .map((feature) => {
      const attributes = feature?.attributes || {};
      const lat = Number(attributes.lat ?? attributes.LAT ?? attributes.latitude ?? attributes.y ?? feature?.geometry?.y);
      const lon = Number(attributes.lon ?? attributes.LON ?? attributes.longitude ?? attributes.x ?? feature?.geometry?.x);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }

      const efScale = String(attributes.efscale ?? attributes.EFSCALE ?? attributes.ef_scale ?? 'N/A');
      const color = datColorByEf(efScale);

      const marker = L.circleMarker([lat, lon], {
        radius: 6,
        color: '#ffffff',
        weight: 1,
        fillColor: color,
        fillOpacity: 1,
      });

      const popupHtml = `
        <div class="popup-title">NOAA DAT</div>
        <div class="popup-grid">
          <span>Event</span><strong>${attributes.event_id || attributes.EVENT_ID || 'N/A'}</strong>
          <span>EF</span><strong>${efScale}</strong>
          <span>Office</span><strong>${attributes.office || attributes.OFFICE || 'N/A'}</strong>
          <span>Damage</span><strong>${attributes.damage_txt || attributes.DAMAGE_TXT || 'N/A'}</strong>
          <span>Lat/Lon</span><strong>${lat.toFixed(3)}, ${lon.toFixed(3)}</strong>
        </div>
      `;
      marker.bindPopup(popupHtml);
      return marker;
    })
    .filter(Boolean);

  markers.forEach((marker) => marker.addTo(state.datLayerGroup));
}

function datColorByEf(value) {
  const text = String(value || '').trim().toUpperCase();
  const palette = {
    EF5: '#9d174d',
    EF4: '#dc2626',
    EF3: '#f59e0b',
    'EF3+': '#f59e0b',
    EF2: '#facc15',
    EF1: '#4ade80',
    EF0: '#22d3ee',
    EFU: '#94a3b8',
    TSTM: '#a78bfa',
    'TSTM/WIND': '#a78bfa',
    WIND: '#a78bfa',
    TROPICAL: '#f97316',
    'N/A': '#cbd5e1',
    UNKNOWN: '#cbd5e1',
    '<NULL>': '#cbd5e1',
  };
  return palette[text] || '#60a5fa';
}