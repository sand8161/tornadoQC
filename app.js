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
  countyLabelsLayer: null,
  countyLayer: null,
  radarLayer: null,
  radarType: 'reflectivity', // 'off', 'reflectivity', or 'velocity'
  radarOpacity: 0.65,
  radarOffsetMinutes: 0,
  baseTileLayer: null,
  theme: 'dark',
  radarRequestToken: 0,
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
  state.map.on('zoomend', () => {
    if (state.countyLayer) renderCountyLabels();
  });

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

      if (state.countyLabelsLayer) {
        if (state.countyLayerVisible) {
          if (!state.map.hasLayer(state.countyLabelsLayer)) {
            state.countyLabelsLayer.addTo(state.map);
          }
        } else if (state.map.hasLayer(state.countyLabelsLayer)) {
          state.map.removeLayer(state.countyLabelsLayer);
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

  if (resetButton) {
    resetButton.addEventListener('click', () => {
      if (state.allBounds && state.allBounds.isValid()) {
        state.map.fitBounds(state.allBounds, { padding: [24, 24] });
        return;
      }
      zoomToConus();
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
}

function renderEditor() {
  const form = document.getElementById('segmentForm');
  const empty = document.getElementById('selectionEmpty');
  const selectionLabel = document.getElementById('selectionLabel');
  const record = getSelectedRecord();

  updateDatLayerSectionVisibility();

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
  document.getElementById('pathLength').value = record.lengthMiles ?? '';
  document.getElementById('pathWidth').value = record.widthYards ?? '';
  document.getElementById('qcNotes').value = record.qcNotes || '';

  if (selectionLabel) {
    selectionLabel.textContent = `${record.source || 'Report'} • ${record.beginDate || 'n/a'} • ${record.magnitude ?? 'n/a'}`;
  }
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
    return rowYear >= state.yearMin && rowYear <= state.yearMax;
  });

  let spcRows = [];
  if (state.spcLayerVisible) {
    spcRows = state.spcRows.filter((row) => {
      const rowYear = Number(row.year || getYearFromDate(row.beginDate));
      const inRange = rowYear >= state.yearMin && rowYear <= state.yearMax;
      const multiCountyPass = !state.spcMultiCountyOnly || isMultiCountyRow(row);
      return inRange && multiCountyPass;
    });
  }

  const filtered = [
    ...(state.spcLayerVisible ? spcRows : []),
    ...(state.nceiLayerVisible ? primaryRows : []),
  ];
  state.filtered = filtered;
  if (state.polyLines) state.polyLines.clear();

  if (state.layerGroup) {
    state.layerGroup.clearLayers();
    if (!state.map.hasLayer(state.layerGroup)) {
      state.layerGroup.addTo(state.map);
    }
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
    const isSpc = row.source === 'SPC';
    const color = magnitudeColor(row.magnitude);
    const startPoint = [row.beginLatitude, row.beginLongitude];
    const endPoint = [row.endLatitude, row.endLongitude];
    const layerOpacity = isSpc ? state.spcOpacity : state.nceiOpacity;

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

    const startMarker = L.circleMarker(startPoint, {
      radius: 4,
      color: '#f8fafc',
      fillColor: color,
      fillOpacity: layerOpacity,
      weight: 1,
      opacity: layerOpacity,
    });
    if (row.source !== 'CSV') {
      startMarker.bindPopup(buildPopup(row));
    }
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

function renderDatLayer(features) {
  clearDatLayer(false);
  if (!features || !features.length || !state.datLayerGroup || !state.datLayerVisible) return;

  updateDatLayerSectionVisibility();

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
        const isNonTornado = /TSTM|WIND|TROPICAL/i.test(efValue);

        if (isNonTornado) {
          const marker = L.circleMarker([lat, lon], {
            pane: 'datPointsPane',
            renderer: state.datRenderers.points,
            radius: 6, color: '#ffffff', weight: 1, fillColor: color, fillOpacity: state.datOpacity,
          });
          marker.bindPopup(popupHtml);
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
          return marker;
        }
      }

      if (geometry.type === 'MultiPoint' || geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
        if (!state.datPathsVisible) return null;
        const latLngs = geometry.coordinates ? coordinatesToLatLngs(geometry.coordinates) : [];
        const line = L.polyline(latLngs, {
          pane: 'datLinesPane',
          renderer: state.datRenderers.lines,
          color: datColorByEf(efValue), weight: 3, opacity: state.datOpacity,
        });
        line.bindPopup(popupHtml);
        return line;
      }

      if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
        if (!state.datPolygonsVisible) return null;
        const latLngs = geometry.coordinates ? polygonCoordinatesToLatLngs(geometry.coordinates) : [];
        const polygon = L.polygon(latLngs, {
          pane: 'datPolygonsPane',
          renderer: state.datRenderers.polygons,
          color: datColorByEf(efValue), fillColor: datColorByEf(efValue), fillOpacity: state.datOpacity * 0.35, weight: 2, opacity: state.datOpacity,
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

const SUN_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
const MOON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

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

async function loadCountyBoundaries() {
  const basePath = 'cb_2018_us_county_5m/cb_2018_us_county_5m';

  try {
    if (window.location.protocol === 'file:') {
      console.warn('County boundaries are not available from a file:// page. Use a local web server or GitHub Pages.');
      return;
    }

    const shpUrl = resolveAssetUrl(`${basePath}.shp`);
    const geojson = await shp(shpUrl);

    state.countyLayer = L.geoJSON(geojson, {
      pane: 'countyPane',
      style: {
        color: '#64748b',
        weight: 1,
        opacity: 0.55,
        fillColor: 'transparent',
        fillOpacity: 0,
        interactive: false
      }
    });
    state.countyLayer.addTo(state.map);
    renderCountyLabels();
  } catch (err) {
    try {
      const geojsonDir = await shp(resolveAssetUrl(basePath));
      state.countyLayer = L.geoJSON(geojsonDir, {
        pane: 'countyPane',
        style: {
          color: '#64748b',
          weight: 1,
          opacity: 0.55,
          fillColor: 'transparent',
          fillOpacity: 0,
          interactive: false
        }
      });
      state.countyLayer.addTo(state.map);
      renderCountyLabels();
    } catch (dirErr) {
      console.warn('Failed to load county shapefile:', err, dirErr);
    }
  }
}

function pointInPolygon(latlng, ring) {
  const x = latlng.lng;
  const y = latlng.lat;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersects = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);

    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInCountyGeometry(latlng, geometry) {
  if (!geometry) return false;

  if (geometry.type === 'Polygon') {
    return geometry.coordinates.some((ring) => pointInPolygon(latlng, ring));
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) =>
      polygon.some((ring) => pointInPolygon(latlng, ring))
    );
  }

  return false;
}

function findLabelCenterInsideCounty(map, geometry, preferredCenter, textWidthPx, textHeightPx) {
  const preferredPoint = map.latLngToContainerPoint(preferredCenter);
  const searchRadius = Math.max(18, Math.min(90, Math.max(textWidthPx, textHeightPx) * 0.75));
  const candidates = [];

  for (let y = -searchRadius; y <= searchRadius; y += Math.max(8, searchRadius / 4)) {
    for (let x = -searchRadius; x <= searchRadius; x += Math.max(8, searchRadius / 4)) {
      const testPoint = map.containerPointToLatLng({
        x: preferredPoint.x + x,
        y: preferredPoint.y + y,
      });

      if (!pointInCountyGeometry(testPoint, geometry)) continue;

      const halfW = textWidthPx / 2;
      const halfH = textHeightPx / 2;
      const samplePoints = [
        { x: x - halfW, y: y - halfH },
        { x: x + halfW, y: y - halfH },
        { x: x - halfW, y: y + halfH },
        { x: x + halfW, y: y + halfH },
        { x: x, y: y - halfH },
        { x: x, y: y + halfH },
        { x: x - halfW, y: y },
        { x: x + halfW, y: y },
        { x: x, y: y },
      ];

      const fits = samplePoints.every((offset) => {
        const sampleLatLng = map.containerPointToLatLng({
          x: preferredPoint.x + offset.x,
          y: preferredPoint.y + offset.y,
        });
        return pointInCountyGeometry(sampleLatLng, geometry);
      });

      if (fits) {
        candidates.push({
          point: testPoint,
          distance: Math.hypot(x, y),
        });
      }
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0].point;
}

function renderCountyLabels() {
  if (!state.map || !window.L) return;
  if (state.map.getZoom() < 6) {
    if (state.countyLabelsLayer) {
      state.map.removeLayer(state.countyLabelsLayer);
      state.countyLabelsLayer = null;
    }
    return;
  }

  if (state.countyLabelsLayer) {
    state.map.removeLayer(state.countyLabelsLayer);
    state.countyLabelsLayer = null;
  }

  const labels = [];
  const countyLayer = state.countyLayer;
  if (!countyLayer || !countyLayer.getLayers) return;

  const map = state.map;
  countyLayer.getLayers().forEach((featureLayer) => {
    const feature = featureLayer.feature;
    if (!feature || !feature.properties || !feature.geometry) return;

    const props = feature.properties;
    const name = firstNonEmpty(
      props.NAME,
      props.name,
      props.NAMELSAD,
      props.namelsad,
      props.County,
      props.county,
      props.NAME_1,
      props.name_1,
      props.CountyName,
      props.county_name
    );
    if (!name) return;

    const bounds = featureLayer.getBounds ? featureLayer.getBounds() : null;
    if (!bounds) return;

    const sw = map.latLngToContainerPoint(bounds.getSouthWest());
    const ne = map.latLngToContainerPoint(bounds.getNorthEast());
    const countyWidthPx = Math.max(30, Math.abs(ne.x - sw.x));
    const countyHeightPx = Math.max(20, Math.abs(ne.y - sw.y));
    const estimatedTextWidthPx = String(name).length * 6.4;
    const estimatedTextHeightPx = 14;

    if (countyWidthPx < 52 || countyHeightPx < 18) return;
    if (estimatedTextWidthPx > countyWidthPx * 0.8 || estimatedTextHeightPx > countyHeightPx * 0.75) return;

    const fontSize = Math.min(8, Math.max(6, (countyWidthPx / Math.max(estimatedTextWidthPx, 1)) * 8));
    const center = bounds.getCenter();
    const labelCenter = findLabelCenterInsideCounty(
      map,
      feature.geometry,
      center,
      estimatedTextWidthPx,
      estimatedTextHeightPx
    );
    if (!labelCenter) return;

    const labelHtml = `
      <span style="display:inline-flex; align-items:center; justify-content:center; font-size:${fontSize}px; line-height:1; font-weight:700; letter-spacing:0.02em; white-space:nowrap; text-align:center; color:rgba(226,232,240,0.93); text-shadow:0 1px 2px rgba(15,23,42,0.7);">${String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
    `;

    const label = L.marker([labelCenter.lat, labelCenter.lng], {
      pane: 'countyPane',
      opacity: 1,
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'county-name-label',
        html: labelHtml,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      })
    });

    labels.push(label);
  });

  if (!labels.length) return;

  state.countyLabelsLayer = L.layerGroup(labels).addTo(state.map);
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
  const button = document.getElementById('exportCorrections');
  if (!button) return;

  const count = state.corrections ? state.corrections.size : 0;
  const baseText = 'Export corrections';
  button.textContent = count > 0 ? `${baseText} (${count})` : baseText;
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