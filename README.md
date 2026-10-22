# TornadoQC

This repo hosts a lightweight GitHub Pages map for NOAA SPC tornado records.

## What it does

- Downloads the SPC tornado dataset from NOAA: https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv
- Maps each tornado track as a line segment from start to end coordinates
- Lets you filter by year and minimum magnitude
- Provides a zoomable and pannable Leaflet map
- Shows per-track details in a popup

## GitHub Pages

To publish the site:

1. Push this repository to GitHub.
2. In the repository settings, enable GitHub Pages.
3. Set the source to the root branch and `/` folder if using the default static site.
4. The site will be available at:
   https://sand8161.github.io/tornadoQC/

## Local preview

From the repo root:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

## Notes

The map fetches the NOAA CSV directly from SPC. If that endpoint is unavailable from the browser, the script falls back to a no-CORS proxy.
