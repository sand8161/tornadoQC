import argparse
import os
import sys

import numpy as np
import pandas as pd
from shapely.geometry import LineString, Point
from tqdm import tqdm


SPC_TZ_OFFSETS = {0: 0, 1: -5, 2: -5, 3: -6, 4: -7, 5: -8, 6: -9, 7: -10}
DEFAULT_TIME_WINDOW_HOURS = 2.0
DEFAULT_MAX_PATH_DISTANCE_KM = 50.0

def parse_report_timestamp(series):
   parsed = pd.to_datetime(series, format="%Y%m%d-%H%M", errors="coerce", utc=True)
   unix = pd.Series(parsed.astype("int64", copy=False) // 10**9, index=series.index, dtype="float64")
   unix.loc[parsed.isna()] = np.nan
   return unix

def treat_zero_as_missing(series):
   numeric = pd.to_numeric(series, errors="coerce")
   return numeric.mask(np.isclose(np.abs(numeric), 0.0), np.nan)

def load_reports(report_file):
   df = pd.read_csv(report_file, encoding="utf8", low_memory=False, na_values=[-99900, "-99900"])
   if "tornado" in df.columns:
      df = df[pd.to_numeric(df["tornado"], errors="coerce") == 1].copy()
   if "beginUnix" not in df.columns and "beginTimestamp" in df.columns:
      df["beginUnix"] = parse_report_timestamp(df["beginTimestamp"])
   if "endUnix" not in df.columns and "endTimestamp" in df.columns:
      df["endUnix"] = parse_report_timestamp(df["endTimestamp"])

   for col in ["beginLatitude", "beginLongitude", "endLatitude", "endLongitude"]:
      if col in df.columns:
         df[col] = treat_zero_as_missing(df[col])

   required = ["stormEventsReportID", "beginUnix", "endUnix", "beginLatitude", "beginLongitude", "endLatitude", "endLongitude", "oneTorID"]
   missing = [c for c in required if c not in df.columns]
   if missing:
      raise ValueError("Missing required report columns: {}".format(", ".join(missing)))

   df = df.dropna(subset=required).copy()
   return df.reset_index(drop=True)


def parse_spc_local_datetime(date_val, time_val):
   if pd.isna(date_val) or pd.isna(time_val):
      return pd.NaT
   date_str = str(date_val).strip()
   time_str = str(time_val).strip()
   if not date_str or date_str.lower() == "nan" or not time_str or time_str.lower() == "nan":
      return pd.NaT
   for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y%m%d %H%M", "%Y%m%d %H:%M:%S"]:
      parsed = pd.to_datetime(f"{date_str} {time_str}", format=fmt, errors="coerce")
      if pd.notna(parsed):
         return parsed
   return pd.to_datetime(f"{date_str} {time_str}", errors="coerce")


def spc_tz_to_offset(val):
   num = pd.to_numeric(pd.Series([val]), errors="coerce").iloc[0]
   if pd.isna(num):
      return 0
   num = int(num)
   if -12 <= num <= 12 and num < 0:
      return num
   if num in SPC_TZ_OFFSETS:
      return SPC_TZ_OFFSETS[num]
   if -12 <= num <= 12:
      return num
   return 0

def calculateDistVec(lat1, lon1, lat2, lon2, labels = [], limit = None):
   R = 6373.0  # Radius of the Earth in kilometers

   # Convert latitudes and longitudes to radians (vectorized)
   rlat1 = np.radians(lat1)
   rlon1 = np.radians(lon1)
   rlat2 = np.radians(lat2)
   rlon2 = np.radians(lon2)

   # Calculate differences (vectorized)
   dlat = rlat2 - rlat1
   dlon = rlon2 - rlon1

   # Apply the Haversine formula (vectorized)
   a = np.sin(dlat / 2)**2 + np.cos(rlat1) * np.cos(rlat2) * np.sin(dlon / 2)**2
   c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))

   # Calculate distance (vectorized)
   distance = R * c

   if len(labels) > 0:
      # Convert radar_ids to a numpy array (ensuring it matches the length of distances)
      labels = np.array(labels, dtype=object)

      # Stack the distance and radar_ids
      pairedResult = np.column_stack((distance, labels))

      if limit:
         filteredResult = pairedResult[pairedResult[:, 0] < limit]

      # Sort by the first column (distance), which is the distance column
      sortedFilteredResult = filteredResult[filteredResult[:, 0].argsort()]
   
      return sortedFilteredResult
   
   return distance

def load_spc_file(spc_file):
   try:
      spc = pd.read_csv(spc_file, encoding="utf8", sep=None, engine="python")
   except Exception:
      spc = pd.read_csv(spc_file, encoding="utf8", low_memory=False)
   spc.columns = [c.strip() for c in spc.columns]
   if spc.empty:
      return spc

   for col in ["slat", "slon", "elat", "elon"]:
      if col in spc.columns:
         spc[col] = treat_zero_as_missing(spc[col])

   start_local = [parse_spc_local_datetime(d, t) for d, t in zip(spc.get("date", pd.Series(pd.NA, index=spc.index)), spc.get("time", pd.Series(pd.NA, index=spc.index)))]
   end_local = [parse_spc_local_datetime(d, t) for d, t in zip(spc.get("edat", pd.Series(pd.NA, index=spc.index)), spc.get("etime", pd.Series(pd.NA, index=spc.index)))]
   tz_offsets = [spc_tz_to_offset(v) for v in spc.get("tz", pd.Series(0, index=spc.index))]

   spc["startLocal"] = start_local
   spc["endLocal"] = end_local
   spc["tzOffset"] = tz_offsets
   spc["startUTC"] = [dt - pd.Timedelta(hours=off) if pd.notna(dt) else pd.NaT for dt, off in zip(spc["startLocal"], spc["tzOffset"])]
   spc["endUTC"] = [dt - pd.Timedelta(hours=off) if pd.notna(dt) else pd.NaT for dt, off in zip(spc["endLocal"], spc["tzOffset"])]
   spc["startUnix"] = pd.Series(spc["startUTC"]).astype("int64", copy=False) // 10**9
   spc.loc[pd.isna(spc["startUTC"]), "startUnix"] = np.nan
   spc["endUnix"] = pd.Series(spc["endUTC"]).astype("int64", copy=False) // 10**9
   spc.loc[pd.isna(spc["endUTC"]), "endUnix"] = np.nan

   spc["spcKey"] = [f"SPC_{year}_{om}" for year, om in zip(spc["yr"], spc["om"])]
   return spc.reset_index(drop=True)

def find_unresolved_spc_paths(reports, spc, time_window_hours, max_path_distance_km):
   # max_path_distance_km = 5
   timingGood = {
      spc_key: reports.loc[
         (reports["beginUnix"] <= (end if pd.notna(end) else start) + time_window_hours * 3600)
         & (reports["endUnix"] >= start - time_window_hours * 3600),
         "stormEventsReportID",
      ].tolist()
      for spc_key, start, end in zip(spc["spcKey"], spc["startUnix"], spc["endUnix"])
   }

   print("Calculating distances from SPC start and end points to report segments (2):")
   sdists = {
      spc_key: calculateDistVec(
         lat,
         lon,
         reports[reports["stormEventsReportID"].isin(timingGood[spc_key])]["beginLatitude"].values,
         reports[reports["stormEventsReportID"].isin(timingGood[spc_key])]["beginLongitude"].values,
         reports[reports["stormEventsReportID"].isin(timingGood[spc_key])]["oneTorID"].values,
         max_path_distance_km,
      ) if len(timingGood[spc_key]) > 0 and pd.notna(lat) and pd.notna(lon) else []
      for lat, lon, spc_key in zip(tqdm(spc["slat"]), spc["slon"], spc["spcKey"])
   }
   edists = {
      spc_key: calculateDistVec(
         lat,
         lon,
         reports[reports["stormEventsReportID"].isin(timingGood[spc_key])]["endLatitude"].values,
         reports[reports["stormEventsReportID"].isin(timingGood[spc_key])]["endLongitude"].values,
         reports[reports["stormEventsReportID"].isin(timingGood[spc_key])]["oneTorID"].values,
         max_path_distance_km,
      ) if len(timingGood[spc_key]) > 0 and pd.notna(lat) and pd.notna(lon) else []
      for lat, lon, spc_key in zip(tqdm(spc["elat"]), spc["elon"], spc["spcKey"])
   }

   idsToRemove = set()
   matching_report_ids = []
   matching_distances = []

   print("Finding unresolved SPC paths:")
   for spc_key in tqdm(spc["spcKey"]):
      sreps = sdists.get(spc_key, [])
      ereps = edists.get(spc_key, [])
      row_matching_report_ids = pd.NA
      row_matching_distances = pd.NA

      if len(sreps) == 0:
         print(f"SPC {spc_key}: no start candidates found")
         matching_report_ids.append(row_matching_report_ids)
         matching_distances.append(row_matching_distances)
         continue

      # print(f"SPC {spc_key}: {len(sreps)} start candidates, {len(ereps)} end candidates")
      # print(f"SPC {spc_key}: start candidates: {[r[1] for r in sreps]}")
      # print(f"SPC {spc_key}: end candidates: {[r[1] for r in ereps]}")

      sids = [report_id for dist, report_id in sreps]
      eids = [report_id for dist, report_id in ereps]

      # If the SPC end point is missing and the start point is a perfect match,
      # the SPC row can still be considered resolved and removed.
      if len(eids) == 0:
         if sreps[0][0] <= 2:
            # print(f"SPC {spc_key}: end point missing; start candidate is a perfect match: {sids[0]}")
            idsToRemove.add(spc_key)
      elif sids[0] == eids[0]:
         if sreps[0][0] <= 2 and ereps[0][0] <= 2:
            # print(f"SPC {spc_key}: start and end candidates are the same: {sids[0]}")
            idsToRemove.add(spc_key)
      else:
         # print(f"SPC {spc_key}: start and end candidates are different: {sids[0]} (start), {eids[0]} (end)")
         idlist = list(set(sids + eids))
         row_matching_report_ids = ";".join(map(str, idlist))
         combined_reps = list(sreps) + list(ereps)
         row_matching_distances = ";".join([str(round(dist, 2)) for dist, report_id in combined_reps if report_id in idlist])
      matching_report_ids.append(row_matching_report_ids)
      matching_distances.append(row_matching_distances)
   print("Removing SPC rows with matching start and end report IDs:", len(idsToRemove))

   spc["matchingReportIDs"] = matching_report_ids
   spc["matchingDistances"] = matching_distances
   spc = spc[~spc["spcKey"].isin(idsToRemove)].copy()

   return spc

def main(report_file, spc_file, output_dir, output_prefix="", time_window_hours=DEFAULT_TIME_WINDOW_HOURS, max_path_distance_km=DEFAULT_MAX_PATH_DISTANCE_KM):
   reports = load_reports(report_file)
   spc = load_spc_file(spc_file)
   if spc.empty:
      print("No SPC rows available after filtering.")
      return 0

   summary_df = find_unresolved_spc_paths(reports, spc, time_window_hours, max_path_distance_km)

   os.makedirs(output_dir, exist_ok=True)
   if not output_prefix:
      report_base = os.path.splitext(os.path.basename(report_file))[0]
      output_prefix = f"{report_base}_spc_unresolved"

   summary_path = os.path.join(output_dir, f"{output_prefix}.csv")
   summary_df.to_csv(summary_path, index=False, na_rep="-99900")

   print(f"Wrote unresolved SPC paths: {summary_path}")
   print(f"Unresolved SPC tornadoes found: {len(summary_df)}")
   return 0


if __name__ == "__main__":
   parser = argparse.ArgumentParser(
      description="Use SPC multi-county tornado paths to find StormEvents report IDs that may stitch together into the full tornado path."
   )
   parser.add_argument("reportFile", type=str, help="createReportFile output CSV")
   parser.add_argument("spcFile", type=str, help="SPC multi-county tornado CSV")
   parser.add_argument("outputDir", type=str, help="Directory for output CSVs")
   parser.add_argument("-o", "--output-prefix", type=str, default="", help="Optional output file prefix")
   parser.add_argument("-t", "--time-window-hours", type=float, default=DEFAULT_TIME_WINDOW_HOURS, help="Hours before/after the SPC event to search for report segments")
   parser.add_argument("-d", "--max-path-distance-km", type=float, default=DEFAULT_MAX_PATH_DISTANCE_KM, help="Maximum distance from SPC path to keep a report as a candidate")
   args = parser.parse_args(sys.argv[1:])

   if not os.path.exists(args.reportFile):
      print(f"Report file does not exist: {args.reportFile}")
      raise SystemExit(1)
   if not os.path.exists(args.spcFile):
      print(f"SPC file does not exist: {args.spcFile}")
      raise SystemExit(1)

   main(
      args.reportFile,
      args.spcFile,
      args.outputDir,
      output_prefix=args.output_prefix,
      time_window_hours=args.time_window_hours,
      max_path_distance_km=args.max_path_distance_km,
   )