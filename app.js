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
  datPointsVisible: true,
  datPathsVisible: true,
  datPolygonsVisible: true,
  radarStations: [],
  datRenderers: {},
  radarLayer: null,
  radarType: 'off', // 'off', 'reflectivity', or 'velocity'
};

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

  // Strictly enforce DAT layering order (Polygons bottom, Lines middle, Points top)
// Strictly enforce DAT layering order (Polygons bottom, Lines middle, Points top)
  state.map.createPane('datPolygonsPane');
  state.map.getPane('datPolygonsPane').style.zIndex = 390;
  state.datRenderers.polygons = L.svg({ pane: 'datPolygonsPane' });
  
  state.map.createPane('datLinesPane');
  state.map.getPane('datLinesPane').style.zIndex = 400;
  state.datRenderers.lines = L.svg({ pane: 'datLinesPane' });
  
  state.map.createPane('datPointsPane');
  state.map.getPane('datPointsPane').style.zIndex = 410;
  state.datRenderers.points = L.svg({ pane: 'datPointsPane' });

  state.layerGroup = L.layerGroup().addTo(state.map);
  state.datLayerGroup = L.layerGroup().addTo(state.map);
  
  bindControls();
  updateSpcControls();
  applyTheme('dark');
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

  if (magnitudeInput) {
    magnitudeInput.addEventListener('change', () => {
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
  ['datPolyToggle', 'datPathToggle', 'datPointToggle'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => {
        if (id === 'datPolyToggle') state.datPolygonsVisible = !state.datPolygonsVisible;
        if (id === 'datPathToggle') state.datPathsVisible = !state.datPathsVisible;
        if (id === 'datPointToggle') state.datPointsVisible = !state.datPointsVisible;
        
        btn.classList.toggle('active');
        renderDatLayer(state.noaaDatMatches); // Re-render the layer with current visibility rules
      });
    }
  });
  ['radarReflectivityBtn', 'radarVelocityBtn', 'radarOffBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => {
        // Update state
        if (id === 'radarReflectivityBtn') state.radarType = 'reflectivity';
        if (id === 'radarVelocityBtn') state.radarType = 'velocity';
        if (id === 'radarOffBtn') state.radarType = 'off';
        
        // Update button UI
        document.getElementById('radarReflectivityBtn').classList.toggle('active', state.radarType === 'reflectivity');
        document.getElementById('radarVelocityBtn').classList.toggle('active', state.radarType === 'velocity');
        document.getElementById('radarOffBtn').classList.toggle('active', state.radarType === 'off');

        // Apply radar
        updateIemRadar();
      });
    }
  });

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
      
      // Reset all track styles to normal
      if (state.polyLines) {
        state.polyLines.forEach((layer) => {
          if (layer.setStyle) layer.setStyle({ weight: 3, opacity: 0.8 });
        });
      }
      
      // Wipe the old DAT polygons/points
      clearDatLayer(); 
      
      renderEditor();
      setStatus('Selection cleared.');
    });
  }
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
  document.getElementById('qcNotes').value = record.qcNotes || '';

  if (selectionLabel) {
    selectionLabel.textContent = `${record.source || 'Report'} • ${record.beginDate || 'n/a'} • ${record.magnitude ?? 'n/a'}`;
  }
}

function toCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '';
  }

  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const escapeCell = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
  
  // Safely clear all Leaflet layers to prevent ghost click events
  if (state.layerGroup) {
    state.layerGroup.clearLayers();
    // Re-add to map if it was accidentally removed
    if (!state.map.hasLayer(state.layerGroup)) {
      state.layerGroup.addTo(state.map);
    }
  }
  if (state.datLayerGroup) state.datLayerGroup.clearLayers();

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

    bounds.extend([startPoint, endPoint]);
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

let currentDatSearchId = 0;

async function handleTrackSelection(record, preserveMapView = true) {
  if (!record) return;

  state.selectedId = record.id;
  renderEditor();
  
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

  if (matches && matches.length) {
    setStatus(`Selected ${record.reportId || record.id}. DAT found ${matches.length} feature(s).`, false);
  } else {
    setStatus(`Selected ${record.reportId || record.id}. 0 DAT features found.`, false);
  }
  updateIemRadar();
}

function clearDatLayer() {
  if (state.datLayerGroup) state.datLayerGroup.clearLayers();
  state.noaaDatMatches = [];
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

      // 1. POINTS
      if (geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
        if (!state.datPointsVisible) return null;
        
        const [lon, lat] = geometry.coordinates;
        const color = datColorByEf(efValue);
        const isNonTornado = /TSTM|WIND|TROPICAL/i.test(efValue);

        if (isNonTornado) {
          // Render circles for non-tornado points
          const marker = L.circleMarker([lat, lon], {
            pane: 'datPointsPane',
            renderer: state.datRenderers.points, // Add this
            radius: 6, color: '#ffffff', weight: 1, fillColor: color, fillOpacity: 1,
          });
          marker.bindPopup(popupHtml);
          return marker;
        } else {
          // Render upside-down SVG triangles for tornado points
          const svgIcon = L.divIcon({
            className: 'dat-point-icon',
            html: `<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 14,0 7,14" fill="${color}" stroke="#ffffff" stroke-width="1"/></svg>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7]
          });
          const marker = L.marker([lat, lon], { pane: 'datPointsPane', icon: svgIcon });
          marker.bindPopup(popupHtml);
          return marker;
        }
      }

      // 2. PATHS (LINES)
      if (geometry.type === 'MultiPoint' || geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
        if (!state.datPathsVisible) return null;
        const latLngs = geometry.coordinates ? coordinatesToLatLngs(geometry.coordinates) : [];
        const line = L.polyline(latLngs, {
          pane: 'datLinesPane',
          renderer: state.datRenderers.lines, // Add this
          color: datColorByEf(efValue), weight: 3, opacity: 0.9,
        });
        line.bindPopup(popupHtml);
        return line;
      }

      // 3. POLYGONS
      if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
        if (!state.datPolygonsVisible) return null;
        const latLngs = geometry.coordinates ? polygonCoordinatesToLatLngs(geometry.coordinates) : [];
        const polygon = L.polygon(latLngs, {
          pane: 'datPolygonsPane',
          renderer: state.datRenderers.polygons, // Add this
          color: datColorByEf(efValue), fillColor: datColorByEf(efValue), fillOpacity: 0.35, weight: 2,
        });
        polygon.bindPopup(popupHtml);
        return polygon;
      }

      return null;
    })
    .filter(Boolean);

  layers.forEach((layer) => layer.addTo(state.datLayerGroup));
}

function datColorByEf(value) {
  const text = String(value || '').trim().toUpperCase();
  
  // Custom non-tornado colors distinct from EF palette
  if (text.includes('TSTM') || text.includes('WIND')) return '#8b5cf6'; // Vivid Purple
  if (text.includes('TROPICAL')) return '#10b981'; // Emerald Green
  if (text === 'UNKNOWN' || text === 'N/A' || text === '<NULL>') return '#a8a29e'; // Warm Grey

  const palette = {
    'EF5': '#9d174d',
    'EF4': '#dc2626',
    'EF3': '#f59e0b',
    'EF3+': '#f59e0b',
    'EF2': '#facc15',
    'EF1': '#4ade80',
    'EF0': '#22d3ee',
    'EFU': '#64748b',
  };
  return palette[text] || '#a8a29e';
}

function coordinatesToLatLngs(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  return coordinates
    .map((segment) => Array.isArray(segment) && segment.length >= 2 ? [segment[1], segment[0]] : null)
    .filter(Boolean);
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
  if (themeButton) {
    themeButton.textContent = mode === 'dark' ? 'Light mode' : 'Dark mode';
  }
}

function updateFilterReadouts() {
  const yearMinInput = document.getElementById('yearMin');
  const yearMaxInput = document.getElementById('yearMax');
  const magnitudeInput = document.getElementById('magnitudeMin');
  const yearRangeValue = document.getElementById('yearRangeValue');
  const yearRangeFill = document.getElementById('yearRangeFill');

  if (yearMinInput && yearMaxInput) {
    yearMinInput.value = String(Math.min(Number(yearMinInput.value || state.yearMin), state.yearMax));
    yearMaxInput.value = String(Math.max(Number(yearMaxInput.value || state.yearMax), state.yearMin));
    state.yearMin = Number(yearMinInput.value);
    state.yearMax = Number(yearMaxInput.value);
  }

  if (yearRangeValue) {
    yearRangeValue.textContent = `${state.yearMin}–${state.yearMax}`;
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
  const magnitudeValue = document.getElementById('magnitudeValue');

  if (yearMinValue) yearMinValue.textContent = String(state.yearMin);
  if (yearMaxValue) yearMaxValue.textContent = String(state.yearMax);
  if (magnitudeInput && magnitudeValue) magnitudeValue.textContent = magnitudeInput.value;
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

  // Changed from textContent to innerHTML to allow the spinner HTML to render
  statusEl.innerHTML = message || '';
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
    yearMinInput.value = String(state.yearMin);
  }
  if (yearMaxInput) {
    yearMaxInput.min = String(state.yearMin);
    yearMaxInput.max = String(state.yearMax);
    yearMaxInput.value = String(state.yearMax);
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
    html += `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(148, 163, 184, 0.2); font-size: 0.8rem; color: #cbd5e1; max-height: 120px; overflow-y: auto;">
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

  const layerIds = [0, 1, 2];
  const unique = new Map();

  const xMin = Math.min(record.beginLongitude, record.endLongitude) - 0.5;
  const yMin = Math.min(record.beginLatitude, record.endLatitude) - 0.5;
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

async function fetchAwsRadar(record) {
  const radarEl = document.getElementById('radarInfo');
  if (!radarEl) return;
  
  if (!state.radarStations.length) {
    radarEl.innerHTML = '<em>Radar station list unavailable.</em>';
    return;
  }

  // Find nearest radar
  let nearest = null;
  let minDst = Infinity;
  for (const station of state.radarStations) {
    const d = getDistanceMiles(record.beginLatitude, record.beginLongitude, station.lat, station.lon);
    if (d < minDst) {
      minDst = d;
      nearest = station;
    }
  }

  const dateStr = normalizeDateString(record.beginDate || record.endDate);
  const timeStr = normalizeTimeString(record.beginTime || '00:00');
  
  // AWS Level-2 archive reliably starts around 1991
  if (!dateStr || Number(dateStr.slice(0,4)) < 1991) {
    radarEl.innerHTML = `<em>AWS Level-2 archive unavailable prior to 1991. Nearest site: ${nearest.id} (${Math.round(minDst)} mi)</em>`;
    return;
  }

  radarEl.innerHTML = `<em>Querying AWS S3 for ${nearest.id} (${Math.round(minDst)} mi away)...</em>`;
  
  const [year, month, day] = dateStr.split('-');
  const prefix = `${year}/${month}/${day}/${nearest.id}/`;
  const s3Url = `https://noaa-nexrad-level2.s3.amazonaws.com/?list-type=2&prefix=${prefix}`;
  const url = `https://corsproxy.io/?url=${encodeURIComponent(s3Url)}`;  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('S3 fetch failed');
    const text = await response.text();
    
    // Parse the AWS XML response
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "text/xml");
    const contents = Array.from(xml.querySelectorAll("Contents"));
    
    if (!contents.length) {
      radarEl.innerHTML = `No data found on AWS for <strong>${nearest.id}</strong> on ${dateStr}. (${Math.round(minDst)} mi away)`;
      return;
    }

    // Find the closest file by time
    const targetMs = new Date(`${dateStr}T${timeStr}:00Z`).getTime();
    let closestFile = null;
    let minTimeDiff = Infinity;

    for (const c of contents) {
      const key = c.querySelector('Key').textContent;
      // Extract HHMMSS from standard NEXRAD filenames: KTLX20130520_195812_V06
      const match = key.match(/_(\d{6})/);
      if (match) {
        const fileMs = new Date(`${dateStr}T${match[1].slice(0,2)}:${match[1].slice(2,4)}:${match[1].slice(4,6)}Z`).getTime();
        const diff = Math.abs(fileMs - targetMs);
        if (diff < minTimeDiff) {
          minTimeDiff = diff;
          closestFile = key;
        }
      }
    }

    if (closestFile) {
      const downloadUrl = `https://noaa-nexrad-level2.s3.amazonaws.com/${closestFile}`;
      const diffMinutes = Math.round(minTimeDiff / 60000);
      radarEl.innerHTML = `
        <strong>Nearest site:</strong> ${nearest.id} (${Math.round(minDst)} mi)<br>
        <strong>Level-2 scan:</strong> <a href="${downloadUrl}" target="_blank">Download .gz</a> 
        <span style="font-size:0.75rem">(${diffMinutes} min offset from start time)</span>
      `;
    } else {
      radarEl.innerHTML = `AWS files found for ${nearest.id}, but time format was unreadable.`;
    }
  } catch (err) {
    console.warn('AWS Radar fetch error', err);
    radarEl.innerHTML = `<em>Failed to query AWS bucket for ${nearest.id}.</em>`;
  }
}
function updateIemRadar() {
  const record = getSelectedRecord();
  const statusEl = document.getElementById('radarStatus');
  
  // Clean up existing radar layer
  if (state.radarLayer) {
    state.map.removeLayer(state.radarLayer);
    state.radarLayer = null;
  }

  if (state.radarType === 'off' || !record) {
    if (statusEl) statusEl.textContent = '';
    return;
  }

  const dateStr = normalizeDateString(record.beginDate || record.endDate);
  const timeStr = normalizeTimeString(record.beginTime || '00:00');
  
  if (!dateStr || Number(dateStr.slice(0, 4)) < 1995) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">Radar archive unavailable before 1995.</span>';
    return;
  }

  // SPC times are usually local (CST). Convert roughly to UTC by adding 6 hours.
  // (For exactness, you'd calculate DST, but 6 hours usually grabs a valid volume scan block)
  let utcDate = new Date(`${dateStr}T${timeStr}:00Z`);
  utcDate.setHours(utcDate.getHours() + 6);
  const timeParam = utcDate.toISOString(); 

  let wmsUrl = '';
  let layerName = '';

  if (state.radarType === 'reflectivity') {
    wmsUrl = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi';
    layerName = 'nexrad-n0q-wmst'; // High-res base reflectivity
  } else if (state.radarType === 'velocity') {
    wmsUrl = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0u-t.cgi';
    layerName = 'nexrad-n0u-wmst'; // High-res base velocity
  }

  state.radarLayer = L.tileLayer.wms(wmsUrl, {
    layers: layerName,
    format: 'image/png',
    transparent: true,
    time: timeParam,
    opacity: 0.65,
    zIndex: 200 // Place it under the tornado tracks (400+) but above base map
  });

  state.radarLayer.addTo(state.map);
  
  if (statusEl) {
    const typeLabel = state.radarType === 'reflectivity' ? 'Reflectivity' : 'Velocity';
    statusEl.textContent = `Showing ${typeLabel} for ~${timeParam.slice(0, 16).replace('T', ' ')} UTC`;
  }
}