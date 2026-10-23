const SPC_URL = 'https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv';
const FALLBACK_URL = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(SPC_URL);

const state = {
  rows: [],
  spcRows: [],
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
  return /\band\b|\b&\b|\,/i.test(countyText) && countyText.length > 3;
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

async function fetchJsonIfAvailable(url) {
  const candidateUrls = [
    url,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];

  const seen = new Set();
  for (const candidateUrl of candidateUrls) {
    if (!candidateUrl || seen.has(candidateUrl)) {
      continue;
    }
    seen.add(candidateUrl);

    try {
      const response = await fetch(candidateUrl, { cache: 'no-store' });
      if (!response.ok) {
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();
      if (!text || !text.trim()) {
        continue;
      }

      const looksLikeJson = contentType.includes('application/json') || contentType.includes('text/json') || text.trim().startsWith('{') || text.trim().startsWith('[');
      if (!looksLikeJson) {
        continue;
      }

      try {
        return JSON.parse(text);
      } catch (error) {
        continue;
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

async function fetchNoaaDatForTrack(record) {
  if (!record) {
    return null;
  }

  const year = Number(record.year || getYearFromDate(record.beginDate) || getYearFromDate(record.endDate));
  if (!Number.isFinite(year) || year <= 0) {
    return null;
  }

  const serviceUrl = 'https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/MapServer/0';
  const rawDate = normalizeDateString(record.beginDate || record.endDate);
  const beginDate = rawDate || `${year}-01-01`;
  const endDate = addDays(beginDate, 2);

  const where = `stormdate >= date '${beginDate}' AND stormdate < date '${endDate}'`;
  const queryUrl = `${serviceUrl}/query?where=${encodeURIComponent(where)}&outFields=stormdate,lat,lon,damage_txt,efscale,office,event_id,damage,injuries,deaths,comments&f=json&resultRecordCount=100`;
  const payload = await fetchJsonIfAvailable(queryUrl);
  if (!payload) {
    return null;
  }

  const features = Array.isArray(payload?.features) ? payload.features : [];
  if (!features.length) {
    return null;
  }

  const filtered = features.filter((feature) => {
    const attrs = feature?.attributes || {};
    const dateValue = attrs.stormdate;
    if (dateValue === undefined || dateValue === null || dateValue === '') {
      return true;
    }

    const normalizedDate = typeof dateValue === 'number'
      ? new Date(dateValue).toISOString().slice(0, 10)
      : normalizeDateString(String(dateValue));

    if (!normalizedDate) {
      return true;
    }

    return normalizedDate >= beginDate && normalizedDate < endDate;
  });

  return filtered.length ? filtered : features.slice(0, 20);
}

async function queryNoaaDatService(serviceUrl, record, targetYear) {
  if (!serviceUrl || !record) {
    return [];
  }

  const rawDate = normalizeDateString(record.beginDate || record.endDate);
  const beginDate = rawDate || `${targetYear}-01-01`;
  const nextDay = addDays(beginDate, 1);

  const where = `stormdate >= date '${beginDate}' AND stormdate < date '${nextDay}'`;
  const queryUrl = `${serviceUrl}/query?where=${encodeURIComponent(where)}&outFields=stormdate,lat,lon,damage_txt,efscale,office,event_id,damage,injuries,deaths,comments&f=json&resultRecordCount=100`;

  const payload = await fetchJsonIfAvailable(queryUrl);
  if (!payload) {
    return [];
  }

  const features = Array.isArray(payload?.features) ? payload.features : [];
  if (!features.length) {
    return [];
  }

  return features;
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