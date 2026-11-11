# TornadoQC

TornadoQC is an interactive web-based application designed for visualizing, analyzing, and performing quality control (QC) on historical tornado track data. It integrates primary tornado datasets (SPC and NCEI) with supplementary damage surveys (NOAA DAT) and historical radar imagery to provide a comprehensive environment for meteorological data correction and export.

## 🌪️ Key Features

* **Interactive Map Visualization:** Built with Leaflet, the app renders thousands of historical tornado tracks, start points, and end points. Tracks are color-coded based on their EF/F-scale rating.
* **Advanced Filtering:** Filter tornado records by a specific year or a custom year range (1950–2026) using an intuitive dual-slider interface.
* **Quality Control (QC) Editor:**
  * Click any tornado track to open it in the QC Editor.
  * Adjust start and end coordinates manually via text inputs or by visually dragging the start/end handles directly on the map.
  * Edit metadata including Begin/End Times, Path Length, Path Width, and add specific QC Notes.
  * Real-time calculation of track length as map handles are dragged.
  * Handy "copy," "paste," and "reset" buttons for quick coordinate management.
* **NOAA Damage Assessment Toolkit (DAT) Integration:**
  * Automatically queries the NOAA DAT ArcGIS REST API based on the selected tornado's date and spatial bounding box.
  * Displays surveyed damage points, paths, and polygons.
  * Fetches and displays DAT damage photos directly in map popups.
* **Historical Radar Integration (IEM):**
  * Automatically finds the nearest NWS WSR-88D radar station to the selected tornado.
  * Fetches historical NEXRAD Level II/III archive scans (Reflectivity and Base Velocity) from the Iowa Environmental Mesonet (IEM).
  * Includes a time scrubber to step forward and backward through radar scans near the event time.
* **Data Export:**
  * **Storm Data Format:** Merges your QC corrections with deep NCEI Storm Events data, correctly formatting UGC codes, FIPS codes, and dynamic location vectors (City/Range/Azimuth) for official NWS Storm Data formatting.
  * **Original Format:** Exports the corrections strictly adhering to the original SPC (Storm Prediction Center) Onetor CSV schema.
* **Customizable UI:** Dark and Light mode themes, plus adjustable opacity sliders for all map layers (NCEI, SPC, DAT, Radar, County Boundaries).

## 📊 Data Sources

The application relies on several bundled and external data sources orchestrated within `app.js`:
* **Tornado Tracks:** Loads bundled CSV chunks (`1950-2026_Tornado_Reports_partX.csv`) and local SPC data (`spc/1950-2025_all_tornadoes.csv`).
* **NCEI Storm Events:** Dynamically fetches deep event details from local versioned CSVs (`ncei/file_map.json`).
* **County Boundaries:** Renders NWS shapefiles (`c_16ap26.zip`) via `shpjs` for accurate geographic context and UGC string generation.
* **NOAA DAT:** Live querying of `services.dat.noaa.gov`.
* **Radar:** Live querying of `mesonet.agron.iastate.edu`.

## 🚀 How to Use

1. **Navigate the Map:** Use standard pan and zoom controls. The map automatically scales markers based on the zoom level to prevent clutter.
2. **Filter Data:** Use the left sidebar to set the desired year range. Toggle specific layers (SPC, NCEI, DAT, Counties) on or off.
3. **Select a Track:** Click on any track line or point on the map. The track will highlight, and the Right Sidebar will populate with the event's details.
4. **View DAT & Radar:** 
   * If DAT surveys exist for that date/location, they will appear on the map automatically. Click them to view ratings and photos.
   * If radar data is available, use the Radar section in the left sidebar to toggle Reflectivity/Velocity and step through timestamps.
5. **Edit & Save:** Make corrections in the QC Editor panel. Click "Save changes".
6. **Export:** Once you have made corrections, click either of the Export buttons in the bottom left to download a formatted CSV of your updated tracks.

## 💻 Technical Stack & File Structure

* `index.html`: The main application shell and UI layout.
* `styles.css`: Contains all styling, CSS variables for theming, and responsive media queries.
* `app.js`: The core application logic. This file handles everything from map initialization and data parsing (PapaParse) to API requests, radar time synchronization, and complex CSV export formatting.

## 🛠️ Local Setup

Because the application fetches local CSV files and shapefiles, it must be run through a local web server to avoid CORS (Cross-Origin Resource Sharing) restrictions.

1. Clone or download the repository.
2. Open a terminal in the project directory.
3. Start a local server. For example, using Python:
   ```bash
   python -m http.server 8000
   ```
4. Open your browser and navigate to `http://localhost:8000`.