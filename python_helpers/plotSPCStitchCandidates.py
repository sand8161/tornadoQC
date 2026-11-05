#############################################################################
#
# Description: Plot SPC tornado paths together with candidate StormEvents
#              report segments from checkMissedTornadoSegments output so the
#              user can visually assign Storm Report IDs to the SPC track.
#
# Example command:
#   python plotSPCStitchCandidates.py \
#       /path/to/SPCmultiCountyTornadoes.csv \
#       /path/to/createReportFile_output_spc_unresolved.csv \
#       /path/to/createReportFile_output.csv \
#       /path/to/output_dir
#
# Author:    GitHub Copilot
# Last edit: 2026-09-30
#
#############################################################################

import argparse
import os
import sys

import geopandas as gpd
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib import patheffects
from shapely.geometry import LineString
from tqdm import tqdm

try:
   from checkMissedTornadoSegments import DEFAULT_COUNTY_SHP
except ImportError:
   DEFAULT_COUNTY_SHP = "/Users/thea.sandmael/data/shapefiles_for_locations/cb_2018_us_county_5m/cb_2018_us_county_5m.shp"

from checkMissedTornadoSegments import load_reports, load_spc_file


def is_missing_coordinate(value):
   if pd.isna(value):
      return True
   try:
      num = float(value)
   except (TypeError, ValueError):
      return True
   return abs(num) < 1e-9


def build_segment_geometries(df):
   geoms = []
   for row in df.itertuples(index=False):
      try:
         begin_lat = float(row.beginLatitude)
         begin_lon = float(row.beginLongitude)
         end_lat = float(row.endLatitude)
         end_lon = float(row.endLongitude)
         if is_missing_coordinate(begin_lat) or is_missing_coordinate(begin_lon) or is_missing_coordinate(end_lat) or is_missing_coordinate(end_lon):
            geoms.append(None)
            continue
         geoms.append(LineString([(begin_lon, begin_lat), (end_lon, end_lat)]))
      except Exception:
         geoms.append(None)
   out = gpd.GeoDataFrame(df.copy(), geometry=geoms, crs="EPSG:4326")
   return out[out.geometry.notna()].copy()


def load_candidate_file(reports_file):
   return pd.read_csv(reports_file, encoding="utf8", low_memory=False, na_values=[-99900, "-99900"])


def parse_id_text(value):
   if pd.isna(value):
      return []
   text = str(value).strip()
   if not text or text.lower() == "nan":
      return []
   ids = []
   for part in text.split(";"):
      part = part.strip()
      if not part:
         continue
      num = pd.to_numeric(pd.Series([part]), errors="coerce").iloc[0]
      if pd.notna(num):
         ids.append(int(num))
   return ids


def normalize_county_geoids(value):
   if value is None:
      return []
   if isinstance(value, str):
      return [part.strip() for part in value.split(";") if part.strip()]
   if isinstance(value, np.ndarray):
      return [str(item).strip() for item in value.tolist() if str(item).strip()]
   if isinstance(value, (list, tuple, set)):
      return [str(item).strip() for item in value if str(item).strip()]
   try:
      if pd.isna(value):
         return []
   except Exception:
      pass
   text = str(value).strip()
   return [text] if text and text.lower() != "nan" else []


def get_spc_context(spc_row, counties):
   county_geoids = set(normalize_county_geoids(spc_row.get("countyGeoids", [])))
   if counties.empty or "GEOID" not in counties.columns:
      return counties.iloc[0:0].copy()
   return counties[counties["GEOID"].isin(county_geoids)].copy()


def plot_county_background(ax, counties, context=None):
   if counties.empty:
      return

   xmin, xmax = ax.get_xlim()
   ymin, ymax = ax.get_ylim()

   try:
      background = counties.cx[xmin:xmax, ymin:ymax].copy()
   except Exception:
      background = counties.copy()

   if not background.empty:
      background.boundary.plot(ax=ax, color="0.8", linewidth=0.45, alpha=0.9, zorder=0)

   if context is not None and not context.empty:
      context.plot(ax=ax, color="whitesmoke", alpha=0.2, zorder=-1)
      context.boundary.plot(ax=ax, color="0.6", linewidth=0.9, zorder=1)


def get_spc_id(spc_row):
   return str(spc_row.get("spcKey", spc_row.get("om", "UNKNOWN")))


def get_plot_file_stem(spc_row):
   spc_id = get_spc_id(spc_row)
   start_dt = pd.to_datetime(spc_row.get("startUTC", pd.NaT), errors="coerce")
   if pd.notna(start_dt):
      date_prefix = start_dt.strftime("%Y%m%d")
      return f"{date_prefix}_{spc_id}_{start_dt.strftime('%H%M')}"

   date_text = str(spc_row.get("date", "")).strip().replace("-", "")
   time_text = str(spc_row.get("time", "")).strip().replace(":", "")
   if date_text and date_text.lower() != "nan" and time_text and time_text.lower() != "nan":
      return f"{date_text}_{spc_id}_{time_text[:4]}"
   return f"{date_text or 'UNKNOWN'}_{spc_id}"


def format_time_label(value):
   if pd.isna(value):
      return ""
   text = str(value).strip()
   if not text or text.lower() == "nat":
      return ""
   parsed = pd.to_datetime(text, errors="coerce")
   if pd.notna(parsed):
      return parsed.strftime("%H%M")
   return text


def annotate_with_offsets(ax, x, y, label, color, used_slots, base_offsets, fontsize=7, zorder=7, use_callout=False):
   if not label:
      return
   slot_key = (round(float(x), 3), round(float(y), 3))
   used_count = used_slots.get(slot_key, 0)
   dx, dy = base_offsets[used_count % len(base_offsets)]
   used_slots[slot_key] = used_count + 1
   arrow_kwargs = {"arrowstyle": "-", "color": color, "lw": 0.8, "alpha": 0.6} if use_callout else {}
   txt = ax.annotate(
      label,
      xy=(float(x), float(y)),
      xytext=(dx, dy),
      textcoords="offset points",
      fontsize=fontsize,
      color=color,
      ha="left" if dx >= 0 else "right",
      va="bottom" if dy >= 0 else "top",
      bbox=dict(boxstyle="round,pad=0.1", facecolor="white", edgecolor="none", alpha=0.85),
      arrowprops=arrow_kwargs if use_callout else None,
      zorder=zorder,
   )
   txt.set_path_effects([patheffects.withStroke(linewidth=1.5, foreground="white")])


def stack_callout_labels(ax, anchors, labels, x_text, y_low, y_high, color, fontsize=7, zorder=8, ha="left", use_box=True):
   items = []
   for anchor, label in zip(anchors, labels):
      if not label:
         continue
      if anchor is None:
         continue
      x_anchor, y_anchor = anchor
      if pd.isna(x_anchor) or pd.isna(y_anchor):
         continue
      items.append((float(x_anchor), float(y_anchor), str(label)))

   if not items:
      return

   ax.figure.canvas.draw()
   trans = ax.transData
   dpi = ax.figure.dpi
   px_per_point = dpi / 72.0
   placed = []

   for x_anchor, y_anchor, label in items:
      candidate_offsets = [
         (18, 12), (-18, 12), (18, -12), (-18, -12),
         (0, 18), (0, -18), (24, 0), (-24, 0),
         (30, 20), (-30, 20), (30, -20), (-30, -20)
      ]
      if x_text is not None and pd.notna(x_text):
         if x_anchor < x_text:
            candidate_offsets = [(-18, 12), (-18, -12), (-24, 0), (-30, 20), (-30, -20), (18, 12), (18, -12), (0, 18), (0, -18)]
         else:
            candidate_offsets = [(18, 12), (18, -12), (24, 0), (30, 20), (30, -20), (-18, 12), (-18, -12), (0, 18), (0, -18)]

      chosen = None
      anchor_px = np.asarray(trans.transform((x_anchor, y_anchor)))
      for dx, dy in candidate_offsets:
         label_px = anchor_px + np.asarray([dx * px_per_point, -dy * px_per_point])
         too_close = False
         for px, py, radius in placed:
            if np.hypot(label_px[0] - px, label_px[1] - py) < radius:
               too_close = True
               break
         if not too_close:
            chosen = (dx, dy)
            placed.append((label_px[0], label_px[1], 28.0))
            break

      if chosen is None:
         chosen = (12, 12)
         label_px = anchor_px + np.asarray([12 * px_per_point, -12 * px_per_point])
         placed.append((label_px[0], label_px[1], 28.0))

      dx, dy = chosen
      txt = ax.annotate(
         label,
         xy=(x_anchor, y_anchor),
         xytext=(dx, dy),
         textcoords="offset points",
         fontsize=fontsize,
         color=color,
         ha="left" if dx >= 0 else "right",
         va="center",
         bbox=dict(boxstyle="round,pad=0.12", facecolor="white", edgecolor="0.7" if use_box else "none", alpha=0.92 if use_box else 0.0),
         arrowprops=dict(arrowstyle="-", color=color, lw=0.8, alpha=0.6),
         zorder=zorder,
      )
      txt.set_path_effects([patheffects.withStroke(linewidth=1.5, foreground="white")])


def add_report_labels(ax, cand_gdf, x_text, y_low, y_high):
   anchors = []
   labels = []
   for row in cand_gdf.itertuples(index=False):
      geom = row.geometry
      if geom is None or geom.is_empty:
         continue
      mid = geom.interpolate(0.5, normalized=True)
      anchors.append((mid.x, mid.y))
      labels.append(str(int(row.stormEventsReportID)) if pd.notna(row.stormEventsReportID) else "NA")

   stack_callout_labels(ax, anchors, labels, x_text, y_low, y_high, "black", fontsize=7.5, zorder=8, ha="left")


def add_time_labels(ax, cand_gdf, x_text_begin, x_text_end, y_low, y_high):
   begin_anchors = []
   begin_labels = []
   end_anchors = []
   end_labels = []

   for row in cand_gdf.itertuples(index=False):
      begin_label = format_time_label(row.beginTimestamp)
      end_label = format_time_label(row.endTimestamp)
      if begin_label:
         begin_anchors.append((row.beginLongitude, row.beginLatitude))
         begin_labels.append(begin_label)
      if end_label:
         end_anchors.append((row.endLongitude, row.endLatitude))
         end_labels.append(end_label)

   midpoint = y_low + (y_high - y_low) * 0.5
   stack_callout_labels(ax, begin_anchors, begin_labels, x_text_begin, midpoint, y_high, "navy", fontsize=6.6, zorder=9, ha="right")
   stack_callout_labels(ax, end_anchors, end_labels, x_text_end, y_low, midpoint, "darkorange", fontsize=6.6, zorder=9, ha="right")


def plot_single_spc(spc_row, unresolved_row, candidate_reports, out_file, counties):
   fig, ax = plt.subplots(figsize=(14, 11))
   used_slots = {}

   context = get_spc_context(spc_row, counties)

   start_valid = False
   end_valid = False
   slon = None
   slat = None
   elon = None
   elat = None

   if pd.notna(spc_row.get("slon", np.nan)) and pd.notna(spc_row.get("slat", np.nan)):
      slon = float(spc_row["slon"])
      slat = float(spc_row["slat"])
      if not is_missing_coordinate(slon) and not is_missing_coordinate(slat):
         start_valid = True

   if pd.notna(spc_row.get("elon", np.nan)) and pd.notna(spc_row.get("elat", np.nan)):
      elon = float(spc_row["elon"])
      elat = float(spc_row["elat"])
      if not is_missing_coordinate(elon) and not is_missing_coordinate(elat):
         end_valid = True

   spc_line = None
   if start_valid and end_valid:
      spc_line = LineString([(slon, slat), (elon, elat)])
      gpd.GeoSeries([spc_line], crs="EPSG:4326").plot(ax=ax, color="black", linewidth=2.5, linestyle="--", zorder=4)

   if start_valid:
      ax.scatter([slon], [slat], color="green", marker="*", s=140, zorder=5, label="SPC start")
      annotate_with_offsets(ax, slon, slat, format_time_label(spc_row.get("startUTC", pd.NaT)), "green", used_slots, [(42, 24), (54, 30), (-54, 30)], fontsize=7, use_callout=True)
   if end_valid:
      ax.scatter([elon], [elat], color="red", marker="X", s=110, zorder=5, label="SPC end")
      annotate_with_offsets(ax, elon, elat, format_time_label(spc_row.get("endUTC", pd.NaT)), "red", used_slots, [(42, -24), (54, -30), (-54, -30)], fontsize=7, use_callout=True)

   point_xs = []
   point_ys = []
   if start_valid:
      point_xs.append(slon)
      point_ys.append(slat)
   if end_valid:
      point_xs.append(elon)
      point_ys.append(elat)

   if spc_line is not None:
      xs, ys = spc_line.xy
      xmin = min(xs)
      xmax = max(xs)
      ymin = min(ys)
      ymax = max(ys)
      xpad = max(0.2, (xmax - xmin) * 0.25)
      ypad = max(0.2, (ymax - ymin) * 0.25)
      ax.set_xlim(xmin - xpad, xmax + xpad)
      ax.set_ylim(ymin - ypad, ymax + ypad)
   elif point_xs:
      xmin = min(point_xs)
      xmax = max(point_xs)
      ymin = min(point_ys)
      ymax = max(point_ys)
      xpad = max(0.2, (xmax - xmin) * 0.5)
      ypad = max(0.2, (ymax - ymin) * 0.5)
      ax.set_xlim(xmin - xpad, xmax + xpad)
      ax.set_ylim(ymin - ypad, ymax + ypad)

   cand_gdf = build_segment_geometries(candidate_reports)
   if not cand_gdf.empty:
      cand_gdf["timeFromSpcStartMin"] = pd.to_numeric(cand_gdf.get("beginUnix", pd.Series(np.nan, index=cand_gdf.index)), errors="coerce")
      start_unix = pd.to_numeric(pd.Series([spc_row.get("startUnix", np.nan)]), errors="coerce").iloc[0]
      cand_gdf["timeFromSpcStartMin"] = np.round((cand_gdf["timeFromSpcStartMin"] - start_unix) / 60.0, 2)
      cand_gdf.plot(ax=ax, column="timeFromSpcStartMin", cmap="viridis", linewidth=2.0, zorder=3, legend=True,
                    legend_kwds={"label": "Minutes from SPC start", "shrink": 0.75})
      ax.scatter(cand_gdf["beginLongitude"], cand_gdf["beginLatitude"], s=22, color="navy", zorder=4)
      ax.scatter(cand_gdf["endLongitude"], cand_gdf["endLatitude"], s=22, color="darkorange", zorder=4)

      seg_xmin = min(cand_gdf["beginLongitude"].min(), cand_gdf["endLongitude"].min())
      seg_xmax = max(cand_gdf["beginLongitude"].max(), cand_gdf["endLongitude"].max())
      seg_ymin = min(cand_gdf["beginLatitude"].min(), cand_gdf["endLatitude"].min())
      seg_ymax = max(cand_gdf["beginLatitude"].max(), cand_gdf["endLatitude"].max())

      if spc_line is None and point_xs:
         xmin = min(min(point_xs), seg_xmin)
         xmax = max(max(point_xs), seg_xmax)
         ymin = min(min(point_ys), seg_ymin)
         ymax = max(max(point_ys), seg_ymax)
         xpad = max(0.2, (xmax - xmin) * 0.15)
         ypad = max(0.2, (ymax - ymin) * 0.15)
         ax.set_xlim(xmin - xpad * 0.95, xmax + xpad * 1.15)
         ax.set_ylim(ymin - ypad, ymax + ypad)
      elif spc_line is not None:
         xmin = min(min(xs), seg_xmin)
         xmax = max(max(xs), seg_xmax)
         ymin = min(min(ys), seg_ymin)
         ymax = max(max(ys), seg_ymax)
         xpad = max(0.2, (xmax - xmin) * 0.15)
         ypad = max(0.2, (ymax - ymin) * 0.15)
         ax.set_xlim(xmin - xpad * 0.95, xmax + xpad * 1.15)
         ax.set_ylim(ymin - ypad, ymax + ypad)

      x_left_outer = xmin - xpad * 0.75
      x_left_inner = xmin - xpad * 0.45
      x_right_outer = xmax + xpad * 0.60
      add_report_labels(ax, cand_gdf, x_right_outer, ymin - ypad, ymax + ypad)
      add_time_labels(ax, cand_gdf, x_left_outer, x_left_inner, ymin - ypad, ymax + ypad)

   plot_county_background(ax, counties, context=context)

   county_geoids = normalize_county_geoids(spc_row.get("countyGeoids", []))
   county_text = ";".join(county_geoids) if county_geoids else "none listed"
   title = f"OM {get_spc_id(spc_row)} | {spc_row.get('yr', 'NA')} {spc_row.get('stateAbbr', 'NA')}"
   subtitle = f"Counties: {county_text} | SPC start: {spc_row.get('startUTC', pd.NaT)} | SPC end: {spc_row.get('endUTC', pd.NaT)} | NS={spc_row.get('ns', 'NA')} | LEN={spc_row.get('len', 'NA')} mi"
   candidate_text = str(unresolved_row.get("matchingReportIDs", unresolved_row.get("possibleNCEIReportIDs", unresolved_row.get("candidateReportIDs", "")))).strip()
   if not candidate_text or candidate_text.lower() == "nan":
      candidate_text = "none listed"
   ax.set_title(title, fontsize=13, pad=12)
   ax.text(
      0.01,
      0.99,
      subtitle,
      transform=ax.transAxes,
      ha="left",
      va="top",
      fontsize=9,
      bbox=dict(boxstyle="round,pad=0.25", facecolor="white", edgecolor="0.7", alpha=0.9),
      zorder=10,
   )
   ax.text(
      0.01,
      0.91,
      f"Possible NCEI IDs: {candidate_text}",
      transform=ax.transAxes,
      ha="left",
      va="top",
      fontsize=9,
      bbox=dict(boxstyle="round,pad=0.25", facecolor="white", edgecolor="0.7", alpha=0.9),
      zorder=10,
   )
   ax.set_xlabel("Longitude")
   ax.set_ylabel("Latitude")
   ax.grid(True, color="0.9", linestyle=":")
   handles, labels = ax.get_legend_handles_labels()
   if handles and labels:
      ax.legend(loc="lower left")
   plt.tight_layout()
   fig.savefig(out_file, dpi=180, bbox_inches="tight")
   plt.close(fig)


def main(spc_file, reports_file, full_reports, output_dir, county_shp=DEFAULT_COUNTY_SHP, only_keys=""):
   spc = load_spc_file(spc_file)
   reports = load_candidate_file(reports_file)

   if only_keys:
      keep = {k.strip() for k in only_keys.split(",") if k.strip()}
      reports = reports[reports["spcKey"].isin(keep)].copy()

   if reports.empty:
      print("No unresolved rows to plot.")
      return 0

   spc_lookup = {str(row.get("spcKey", "")): row for row in spc.to_dict("records")}

   counties = gpd.read_file(county_shp) if county_shp and os.path.exists(county_shp) else gpd.GeoDataFrame()
   os.makedirs(output_dir, exist_ok=True)

   for unresolved_row in tqdm(reports.to_dict("records"), total=len(reports), desc="Plotting unresolved SPC rows"):
      spc_key = str(unresolved_row["spcKey"])
      spc_row = spc_lookup.get(spc_key)
      if spc_row is None:
         continue
      candidate_ids = parse_id_text(unresolved_row.get("matchingReportIDs", unresolved_row.get("possibleNCEIReportIDs", unresolved_row.get("candidateReportIDs", pd.NA))))
      candidate_reports = full_reports[full_reports["stormEventsReportID"].isin(candidate_ids)].copy() if candidate_ids else pd.DataFrame()
      out_file = os.path.join(output_dir, f"{get_plot_file_stem(spc_row)}.png")
      plot_single_spc(spc_row, unresolved_row, candidate_reports, out_file, counties)

   return 0


if __name__ == "__main__":
   parser = argparse.ArgumentParser(description="Plot unresolved SPC tornado paths for manual StormEvents ID assignment using SPC om IDs.")
   parser.add_argument("spcFile", type=str, help="SPC multi-county tornado CSV")
   parser.add_argument("reportsFile", type=str, help="*_spc_unresolved.csv output from checkMissedTornadoSegments")
   parser.add_argument("fullReportFile", type=str, help="Original createReportFile output CSV with report geometries")
   parser.add_argument("outputDir", type=str, help="Directory for output PNG plots")
   parser.add_argument("-c", "--county-shp", type=str, default=DEFAULT_COUNTY_SHP, help="Optional county shapefile for map context")
   parser.add_argument("-k", "--only-keys", type=str, default="", help="Optional comma-separated list of SPC om IDs to plot")
   args = parser.parse_args(sys.argv[1:])

   if not os.path.exists(args.spcFile):
      print(f"SPC file does not exist: {args.spcFile}")
      raise SystemExit(1)
   if not os.path.exists(args.reportsFile):
      print(f"Reports file does not exist: {args.reportsFile}")
      raise SystemExit(1)
   if not os.path.exists(args.fullReportFile):
      print(f"Full report file does not exist: {args.fullReportFile}")
      raise SystemExit(1)

   full_reports = load_reports(args.fullReportFile)
   main(
      args.spcFile,
      args.reportsFile,
      full_reports,
      args.outputDir,
      county_shp=args.county_shp,
      only_keys=args.only_keys,
   )