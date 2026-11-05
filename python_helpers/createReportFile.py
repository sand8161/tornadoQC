#############################################################################
#
# Reads in StormEvent files from NCEI from a specified folder and year range and writes
# a comma separated .csv file to specified output directory of tornado, severe hail and severe thunderstorm wind.
# You can set a time threshold to not include severe reports within a certain time of a tornado.
#
# Example command: python createReportFile.py -d True /Users/theasandmael /Users/theasandmael/Documents/nexrad-stations.csv /Users/theasandmael/Downloads/StormEvents 2013
#
# Author:    Thea Sandmael - 20190509
# Last edit: Thea Sandmael - 20260211
#
#############################################################################

import argparse, datetime, glob, pytz, re, sys, time
import geopandas as gpd
import numpy as np
import pandas as pd
from calendar import timegm
from os import path, makedirs, listdir
from sys import argv
from shapely import Point
from tqdm import tqdm

def main(years, stormDataDir, radarFilePath, outputDir, tcFile = '', dualPol = False,
         timeFormat = "%Y%m%d-%H%M", #"%d-%b-%y %H:%M:%S",
         LSRTextFolder = '', nonsevere = False, outputFile = '', preTorDir = '',
         qcFile = True, onetor = False, stormDataPrefix = '', stormModeFile = '', torOnly = False,
         cwafile = "/Users/thea.sandmael/data/shapefiles_for_locations/w_10nv20/w_10nv20.shp"):

   # Read in CSV and store as a dataframe
   dfr, latName, lonName, radName, dualpolInfo = readRadarCSV(radarFilePath)
   
   checkValidRadar = False
   if "last_date" in dfr.columns and "first_date" in dfr.columns:
      dfr.fillna({"last_date" : int(datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d"))}, inplace=True)
      checkValidRadar = True

   if outputFile == '':
      if len(years) > 1:
         if sorted(years) == list(range(min(years), max(years)+1)): outputFile += str(min(years)) + '-' + str(max(years)) + '_'
         else:
            for year in years: outputFile += str(year) + '_'  
      else: outputFile += str(years[0]) + '_'
      if nonsevere: outputFile += "Storm_Reports"
      elif torOnly: outputFile += "Tornado_Reports"
      else: outputFile += "Severe_Storm_Reports"
   print("This is the output file name: " + outputFile)
   dfs_list = []
   origYears = years.copy()
   if years[0] != 1950: years.append(years[0] - 1)
   print("Reading in data:")
   for year in tqdm(years):
      try:
         if stormDataPrefix == '':
            stormDataFile = glob.glob(stormDataDir + "/StormEvents_details-ftp_v1.0_d" + str(year) + "*")[0]
         else:
            stormDataFile = glob.glob(stormDataDir + "/" + stormDataPrefix + str(year) + "*")[0]
      except OSError as err:
         print("Could not find file for year {}. File must be renamed or set StormDataPrefix to match your files.\n{}\nTrying a different path.".format(year, err))
         try:
            stormDataFile = glob.glob(stormDataDir + "/*" + year + "*")[0]
         except OSError as err:
            print("Could not find any file for year {}:\n{}\Skipping.".format(year, err))
            continue
      # Read in CSV and store as a dataframe
      try:
         dfsAdd = pd.read_csv(stormDataFile, encoding="utf8", na_values=[-99900, "-99900"], low_memory=False)
      except OSError as err:
         print("Error reading file {}:\n{}\nExiting.".format(stormDataFile, err))
         exit()
      dfs_list.append(dfsAdd)

   if len(dfs_list) > 0:
      dfs = pd.concat(dfs_list, ignore_index=True)
   else:
      dfs = pd.DataFrame()
   
   print("Number of reports (all types) before filters:")
   print(len(dfs))
   
   dfst = dfs.query("EVENT_TYPE == 'Tornado'")
   dfss = dfs.query("EVENT_TYPE == 'Waterspout'")
   dfsts = pd.concat([dfst, dfss], ignore_index=True)
   print("Number of tornado+waterspout reports:")
   print(len(dfsts))
   
   if not torOnly:
      filterhail = "EVENT_TYPE == 'Hail'"
      if not nonsevere: filterhail +=" & MAGNITUDE >= 1"
   
      filterwind = "EVENT_TYPE == 'Thunderstorm Wind'"
      if not nonsevere: filterwind +=" & MAGNITUDE >= 50"
      
      dfsh = dfs.query(filterhail)
      dfsh = dfsh.reset_index(drop=True)
      dfsw = dfs.query(filterwind)
      dfsw = dfsw.reset_index(drop=True)
      dfshw = pd.concat([dfsh, dfsw], ignore_index=True)
      print("Number of hail+wind reports:")
      print(len(dfshw))
      dfs = pd.concat([dfsts, dfshw], ignore_index=True)
   else:
      dfs = pd.concat([dfsts], ignore_index=True)

   #dfs["beginUTC"] = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(stime, timeFormat)) - (60*60*timeZone)))
   #                for stime, timeZone, in zip(dfs["BEGIN_DATE_TIME"], dfs["tz"])]
   #dfs["endUTC"] = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(etime, timeFormat)) - (60*60*timeZone)))
   #                for etime, timeZone, in zip(dfs["END_DATE_TIME"], dfs["tz"])]
   dfs["tz"] = [getTZoffset(t) for t in dfs["CZ_TIMEZONE"]]
   dfs["BEGIN_DATE_TIME"] = dfs["BEGIN_YEARMONTH"].astype(str) + dfs["BEGIN_DAY"].astype(str).str.zfill(2) + '-' + dfs["BEGIN_TIME"].astype(str).str.zfill(4)
   dfs["END_DATE_TIME"]   = dfs["END_YEARMONTH"].astype(str)   + dfs["END_DAY"].astype(str).str.zfill(2)   + '-' + dfs["END_TIME"].astype(str).str.zfill(4)
   dfs["beginUTC"] = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(stime, timeFormat)) - (60*60*timeZone)))
                     for stime, timeZone, in zip(dfs["BEGIN_DATE_TIME"], dfs["tz"])]
   dfs["endUTC"] = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(etime, timeFormat)) - (60*60*timeZone)))
                   for etime, timeZone, in zip(dfs["END_DATE_TIME"], dfs["tz"])]
   dfs.sort_values(by=["beginUTC","endUTC"], inplace=True)
   dfs["year"] = [int(d[:4]) for d in dfs["beginUTC"]]
   dfs = dfs[dfs["year"].isin(origYears)]

   print("Final number of reports:")
   print(len(dfs))

   df = pd.DataFrame()

   #for i in range(len(dfs)):
   #   if type(dfs["BEGIN_DATE_TIME"].values[i]) != str:
   #      print(dfs.iloc[i])
   df["beginTimestamp"] = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(stime, timeFormat)) - (60*60*timeZone)))
                           for stime, timeZone in zip(dfs["BEGIN_DATE_TIME"], dfs["tz"])]
   df["beginYear"]      = np.nan
   df["beginMonth"]     = np.nan
   df["beginDay"]       = np.nan
   df["beginTime"]      = np.nan
   df["beginUnix"]      = np.nan
   df["beginTimestampLocal"] = [time.strftime("%Y%m%d-%H%M", time.strptime(stime, timeFormat)) for stime in dfs["BEGIN_DATE_TIME"]]
   df["beginLongitude"] = dfs["BEGIN_LON"].values
   df["beginLatitude"]  = dfs["BEGIN_LAT"].values
   df["endTimestamp"]   = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(stime, timeFormat)) - (60*60*timeZone)))
                           for stime, timeZone, in zip(dfs["END_DATE_TIME"], dfs["tz"])]
   df["endYear"]        = np.nan
   df["endMonth"]       = np.nan
   df["endDay"]         = np.nan
   df["endTime"]        = np.nan
   df["endUnix"]        = np.nan
   df["endTimestampLocal"] = [time.strftime("%Y%m%d-%H%M", time.strptime(stime, timeFormat)) for stime in dfs["END_DATE_TIME"]]
   df["endLongitude"]   = dfs["END_LON"].values
   df["endLatitude"]    = dfs["END_LAT"].values
   df["durationMin"]    = np.nan
   df["tornado"]        = [1 if event == "Tornado" or event == "Waterspout" else 0 for event in dfs["EVENT_TYPE"]]
   df["spout"]          = [1 if event == "Waterspout" or (event == "Tornado" and (not pd.isnull(details) and "spout" in details.lower())) else 0 for event, details in zip(dfs["EVENT_TYPE"], dfs["EVENT_NARRATIVE"])]
   df["anticyclonic"]   = [1 if event == "Tornado" and (not pd.isnull(details) and ("anticyclonic" in details.lower() or "anti-cyclonic" in details.lower())) else 0 for event, details in zip(dfs["EVENT_TYPE"], dfs["EVENT_NARRATIVE"])]
   df["hail"]           = [1 if event == "Hail"              else 0 for event in dfs["EVENT_TYPE"]]
   df["wind"]           = [1 if event == "Thunderstorm Wind" else 0 for event in dfs["EVENT_TYPE"]]
   sevtype = dfs["EVENT_TYPE"].copy()
   df["severeType"]     = sevtype.replace(["Thunderstorm Wind", "Waterspout"], ["Wind", "Tornado"]).values
   mags                 = [ef[-1:] if not pd.isnull(ef) else -1 if pd.isnull(mag) and pd.isnull(ef) else mag if ((tor != 1) and (mag != 0)) else -1 for mag, ef, tor in zip(dfs["MAGNITUDE"], dfs["TOR_F_SCALE"], df["tornado"])]
   df["magnitude"]      = [m if m != "U" else -1 for m in mags]
   df["magnitudeType"]  = [m if t == 0 else pd.NA for m, t in zip(dfs["MAGNITUDE_TYPE"], df["tornado"])]
   if nonsevere:
      df["severeType"]  = ["Unknown"   if (tpe != "Tornado" and mag == -1)
                           else "None" if ((tpe == "Wind" and float(mag) < 50) or (tpe == "Hail" and float(mag) < 1))
                           else tpe
                           for tpe, mag in zip(df["severeType"], df["magnitude"])]
   df["tornadoLength"]    = dfs["TOR_LENGTH"].values
   df["tornadoWidth"]     = dfs["TOR_WIDTH"].values
   df["injuriesDirect"]   = dfs["INJURIES_DIRECT"].values
   df["injuriesIndirect"] = dfs["INJURIES_INDIRECT"].values
   df["deathsDirect"]     = dfs["DEATHS_DIRECT"].values
   df["deathsIndirect"]   = dfs["DEATHS_INDIRECT"].values
   df["damageProperty"]   = dfs["DAMAGE_PROPERTY"].values
   df["damageCrops"]      = dfs["DAMAGE_CROPS"].values
   replDict = {"[kK]": "*1e3", "[mM]": "*1e6", "[bB]": "*1e9", "[hH]": "*1e2", "\?": '', "0\d": '', "^\." : "0."}
   df["damageProperty"] = df["damageProperty"].replace(replDict, regex=True)
   df["damageCrops"]    = df["damageCrops"].replace(replDict, regex=True)
   df["damageProperty"] = [eval(val) if val and type(val) == str and not val[0] == "*" else np.nan if (val and type(val) == str and val[0] == "*") or val == '' else val for val in df["damageProperty"].values]
   df["damageCrops"]    = [eval(val) if val and type(val) == str and not val[0] == "*" else np.nan if (val and type(val) == str and val[0] == "*") or val == '' else val for val in df["damageCrops"].values]
   df["source"]         = dfs["SOURCE"].values
   df["overview"]       = dfs["EPISODE_NARRATIVE"].values
   df["details"]        = dfs["EVENT_NARRATIVE"].values
   df["stormEventsEpisodeID"] = dfs["EPISODE_ID"].values
   df["stormEventsReportID"]  = dfs["EVENT_ID"].values
   df["QCd"]       = 0
   df["corrected"] = 0
   df["QCnotes"]     = pd.Series([pd.NA] * len(df), dtype="object")
   df["autoQCnotes"] = pd.Series([pd.NA] * len(df), dtype="object")
   df["stormID"]     = pd.Series([pd.NA] * len(df), dtype="object")
   df["TCname"]      = pd.Series([pd.NA] * len(df), dtype="object")
   df["stormType"]   = pd.Series([pd.NA] * len(df), dtype="object")
   df["stormMode"]   = pd.Series([pd.NA] * len(df), dtype="object")
   df["stormModeReportID"] = pd.Series([pd.NA] * len(df), dtype="object")
   df["stormModeCode"] = np.nan
   df["RMLM"]      = pd.Series([pd.NA] * len(df), dtype="object")
   df["stormModeSummary"] = pd.Series([pd.NA] * len(df), dtype="object")
   df["previousSegment"]   = np.nan
   df["preTornadoTracked"] = np.nan
   df["county"] = dfs["CZ_NAME"].str.title().values
   df["state"]  = dfs["STATE"].str.title().values
   df["CWA"]    = dfs["WFO"].values
   df["NWSRegion"] = np.nan
   df["segmentNumber"] = np.nan
   if path.exists(cwafile):
      try:                                                                       
         cwash = gpd.read_file(cwafile)
      except OSError as err:
         print("Error reading CWA shapefile {}:\n{}\nExiting.".format(cwafile, err))
         exit()
      print("Finding NWS region:")
      # Keep only needed columns and build a fast CWA->Region mapping.
      cwa_lookup = cwash[["CWA", "Region", "geometry"]].copy()

      if df["CWA"].isna().any():
         miss_mask = df["CWA"].isna() & df["beginLatitude"].notna() & df["beginLongitude"].notna()
         if miss_mask.any():
            miss_points = gpd.GeoDataFrame(df.loc[miss_mask, ["beginLongitude", "beginLatitude"]].copy(),
                                           geometry=gpd.points_from_xy(df.loc[miss_mask, "beginLongitude"],
                                                                       df.loc[miss_mask, "beginLatitude"]),
                                           crs="EPSG:4326")
            # Align CRS once, then do one vectorized spatial join.
            if cwa_lookup.crs is not None and miss_points.crs != cwa_lookup.crs:
               miss_points = miss_points.to_crs(cwa_lookup.crs)

            joined = gpd.sjoin(miss_points,
                               cwa_lookup[["CWA", "geometry"]],
                               how="left",
                               predicate="within")
            df.loc[miss_mask, "CWA"] = joined["CWA"].values

      region_map = cwa_lookup.drop_duplicates(subset=["CWA"]).set_index("CWA")["Region"]
      df["NWSRegion"] = df["CWA"].map(region_map)

   if qcFile:
      try:
         print("Adding QC corrections...")
         dfqc = pd.read_csv(qcFile, encoding="utf8", na_values=[-99900,"-99900"], low_memory=False)
         df_qc = df.copy()
         dfqc["magnitude"] = [m if m != "U" else -1 for m in dfqc["magnitude"]]
         if "QCchange" not in dfqc.columns:
            dfqc["QCchange"] = 0

         # Build QCnotes lookup from QC file (latest row per report ID wins).
         qc_notes_map = pd.Series(dtype="object")
         if "QCnotes" in dfqc.columns:
            qc_notes_map = (dfqc.dropna(subset=["stormEventsReportID"])
                               .drop_duplicates(subset=["stormEventsReportID"], keep="last")
                               .set_index("stormEventsReportID")["QCnotes"])

         # QCchange: -1 remove, 0 change, 1 add
         remove_ids = set(dfqc.loc[dfqc["QCchange"] == -1, "stormEventsReportID"].dropna().values)
         if len(remove_ids) > 0:
            df = df[~df["stormEventsReportID"].isin(remove_ids)].copy()

         dfqc_change = dfqc[dfqc["QCchange"] == 0].copy()
         dfqc_add = dfqc[dfqc["QCchange"] == 1].copy()

         if len(dfqc_change) > 0:
            dfqc_change = dfqc_change.drop_duplicates(subset=["stormEventsReportID"], keep="last")
            dfqc_idx = dfqc_change.set_index("stormEventsReportID")
         else:
            dfqc_idx = pd.DataFrame(index=[])
         # ids_set = set(dfqc_change["stormEventsReportID"].values)
         
         if len(dfqc_change) > 0:
            qc_include_cols = ["beginTimestamp", "beginTimestampLocal", "beginLongitude", "beginLatitude",
                               "endTimestamp", "endTimestampLocal", "endLongitude", "endLatitude",
                               "tornado", "spout", "anticyclonic", "hail", "wind", "severeType",
                               "magnitude", "magnitudeType", "tornadoLength", "tornadoWidth",
                               "injuriesDirect", "injuriesIndirect", "deathsDirect", "deathsIndirect",
                               "damageProperty", "damageCrops", "source", "overview", "details",
                               "stormEventsEpisodeID", "stormEventsReportID", "county", "state", "CWA"]
            qc_compare_cols = [col for col in qc_include_cols if col in df_qc.columns and col in dfqc_change.columns]
            df_qc["QCd"]       = df_qc["stormEventsReportID"].map(dfqc_idx["QCd"]).fillna(0)
            df_qc["corrected"] = df_qc["stormEventsReportID"].map(dfqc_idx["corrected"])
            df_qc["QCnotes"]   = df_qc["stormEventsReportID"].map(dfqc_idx["QCnotes"])
            corrected_ids = set(dfqc_change[dfqc_change["corrected"] == 1]["stormEventsReportID"].values)
            df_qc["autoQCnotes"] = [np.nan if co != 1 else summarizeRowDifferences(df_qc[df_qc["stormEventsReportID"] == id], dfqc_change[dfqc_change["stormEventsReportID"] == id], qc_compare_cols, "Changes from QC") for id, co in zip(df_qc["stormEventsReportID"], df_qc["corrected"])]
         else:
            corrected_ids = set()
            qc_compare_cols = []
         
         mask = df_qc["stormEventsReportID"].isin(corrected_ids)
         for col in qc_compare_cols:
            if len(dfqc_change) > 0 and col in dfqc_idx.columns:
               mapped_vals = df_qc.loc[mask, "stormEventsReportID"].map(dfqc_idx[col])
               # Only overwrite with non-null QC values; avoid forcing casts that can fail
               # when NaN is mapped into integer-typed columns.
               if len(mapped_vals) > 0:
                  target_idx = mapped_vals.index[mapped_vals.notna()]
                  if len(target_idx) > 0:
                     df_qc.loc[target_idx, col] = mapped_vals.loc[target_idx]

         corrected_neg1_ids = set(dfqc[dfqc["corrected"] == -1]["stormEventsReportID"].values) if len(dfqc) > 0 and "corrected" in dfqc.columns else set()
         corrected_neg1_mask = df_qc["stormEventsReportID"].isin(corrected_neg1_ids)
         if corrected_neg1_mask.any():
            df_qc.loc[corrected_neg1_mask, "corrected"] = -1
            if "QCnotes" in df_qc.columns and len(qc_notes_map) > 0:
               df_qc.loc[corrected_neg1_mask, "QCnotes"] = df_qc.loc[corrected_neg1_mask, "stormEventsReportID"].map(qc_notes_map)
            df_qc.loc[corrected_neg1_mask & df_qc["autoQCnotes"].isna(), "autoQCnotes"] = "QC correction unknown."

         # Add brand-new rows requested by QCchange = 1.
         if len(dfqc_add) > 0:
            valid_qc_years = {str(y) for y in origYears}
            add_rows = []
            for _, row in dfqc_add.iterrows():
               # Need timestamps for downstream derived-time calculations.
               if pd.isnull(row.get("beginTimestamp", np.nan)) or pd.isnull(row.get("endTimestamp", np.nan)):
                  continue
               begin_year = str(row.get("beginTimestamp", ""))[:4]
               if begin_year not in valid_qc_years:
                  continue
               newrow = {col: np.nan for col in df.columns}
               for col in df.columns:
                  if col in dfqc_add.columns and not pd.isnull(row.get(col, np.nan)):
                     newrow[col] = row[col]
               newrow["QCd"] = 1 if pd.isnull(newrow["QCd"]) else newrow["QCd"]
               newrow["corrected"] = 1 if pd.isnull(newrow["corrected"]) else newrow["corrected"]
               if pd.isnull(newrow["autoQCnotes"]):
                  newrow["autoQCnotes"] = "Added by QC."
               add_rows.append(newrow)
            if len(add_rows) > 0:
               df_qc = pd.concat([df_qc, pd.DataFrame(add_rows)], ignore_index=True)
            df = df_qc

      except OSError as err:
         print("Something is wrong with the QC file {}:\n{}\nSkipping adding QC info.".format(qcFile, err))

   # Recalculate all non-direct time-derived fields after QC has been applied.
   df["beginYear"]   = [btime[0:4]  for btime in df["beginTimestamp"]]
   df["beginMonth"]  = [btime[4:6]  for btime in df["beginTimestamp"]]
   df["beginDay"]    = [btime[6:8]  for btime in df["beginTimestamp"]]
   df["beginTime"]   = [btime[9:13] for btime in df["beginTimestamp"]]
   df["beginUnix"]   = [timegm(time.strptime(t, "%Y%m%d-%H%M")) for t in df["beginTimestamp"]]
   df["endYear"]     = [etime[0:4]  for etime in df["endTimestamp"]]
   df["endMonth"]    = [etime[4:6]  for etime in df["endTimestamp"]]
   df["endDay"]      = [etime[6:8]  for etime in df["endTimestamp"]]
   df["endTime"]     = [etime[9:13] for etime in df["endTimestamp"]]
   df["endUnix"]     = [timegm(time.strptime(t, "%Y%m%d-%H%M")) for t in df["endTimestamp"]]
   df["durationMin"] = [int((e - b)/60.0) for b, e in zip(df["beginUnix"], df["endUnix"])]

   # Recalculate tornado typing after QC updates.
   waterspout = [1 if sp == 1 else 0 for sp in df["spout"]]
   landspout  = [1 if event == "Tornado" and (not pd.isnull(details) and ("landspout" in details.lower() or "land spout" in details.lower())) else 0 for event, details in zip(df["severeType"], df["details"])]
   df["type"] = ["Unknown"                  if (tpe == "Unknown")
                 else "Non-Severe"          if (tpe == "None")
                 else "Waterspout"          if (wspout == 1)
                 else "Landspout"           if (lspout == 1)
                 else "Tornado"             if (tpe == "Tornado" and mag == "U" and lspout == 0)
                 else "Tornado"             if (tpe == "Tornado" and float(mag) < 2)
                 else "Significant Tornado" if (tpe == "Tornado" and float(mag) > 1)
                 else "Severe Non-Tornadic" if ((tpe == "Hail" and float(mag) < 2) or (tpe == "Wind" and float(mag) < 65))
                 else "Significant Severe Non-Tornadic"
                 for tpe, mag, lspout, wspout in zip(df["severeType"], df["magnitude"], landspout, waterspout)]

   # Remove duplicates after QC updates.
   duplicates = df[df.duplicated(subset=["beginTimestamp", "beginLongitude", "beginLatitude", "type", "hail", "wind"], keep=False)].copy()
   if len(duplicates) > 0:
      dup_debug = duplicates.copy()
      dup_debug["dupKey"] = dup_debug.groupby(["beginTimestamp", "beginLongitude", "beginLatitude", "type", "hail", "wind"]).ngroup()
      if duplicates["beginLongitude"].isna().any():
         duplicates = duplicates[~duplicates["beginLongitude"].isna()]
      duplicates["_endUnix"] = [timegm(time.strptime(t, "%Y%m%d-%H%M")) for t in duplicates["endTimestamp"]]
      duplicates["groups"] = duplicates.groupby(["beginTimestamp"]).ngroup()
      removedupes = [duplicates.iloc[i].name for i in range(len(duplicates)) if pd.isnull(duplicates.iloc[i]["tornadoLength"]) and not duplicates[duplicates["groups"] == duplicates.iloc[i]["groups"]]["tornadoLength"].isna().all()]
      duplicates = duplicates[~duplicates["groups"].isin(duplicates["groups"].loc[removedupes].values)]
      removedupeset = [duplicates[duplicates["_endUnix"] == min(duplicates[duplicates["groups"] == p]["_endUnix"])].iloc[0].name for p in list(set(duplicates["groups"])) if len(set(duplicates[duplicates["groups"] == p]["endTimestamp"])) > 1]
      removedupes += removedupeset
      duplicates = duplicates[~duplicates["groups"].isin(duplicates["groups"].loc[removedupeset].values)]
      removedupeset = [duplicates[duplicates["stormEventsReportID"] == min(duplicates[duplicates["groups"] == p]["stormEventsReportID"])].iloc[0].name for p in list(set(duplicates["groups"]))]
      removedupes += removedupeset
      duplicates = duplicates[~duplicates["groups"].isin(duplicates["groups"].loc[removedupeset].values)]
      if len(duplicates) > 0:
         print("Duplicate removal failed for:")
         with pd.option_context("display.max_columns", None, "display.width", None, "display.max_colwidth", None):
            print(duplicates.to_string(index=False))
      removed_ids = set(df.loc[removedupes, "stormEventsReportID"].values)
      df.drop(index=removedupes, inplace=True)

   if tcFile:
      try:
         print("Adding TC report corrections...")
         dftc = pd.read_csv(tcFile, encoding="utf8", na_values=[-99900,"-99900"])
         dftc = dftc.drop_duplicates(subset=["stormEventsReportID"], keep="first")
         ids = set(dftc["stormEventsReportID"].values)
         tcname_col = next((c for c in dftc.columns if c.lower() == "tcname"), None)

         df["stormType"]   = df["stormType"].where(~df["stormEventsReportID"].isin(ids), "TC")
         if tcname_col:
            df["TCname"] = df["stormEventsReportID"].map(dftc.set_index("stormEventsReportID")[tcname_col]).combine_first(df["TCname"])
      except OSError as err:
            print("Something is wrong with the TC file {}:\n{}\nSkipping adding TC info.".format(tcFile, err))
      print("Calculating all radar distances (2):")
   
   radlats   = dfr[latName].values
   radlons   = dfr[lonName].values
   radlabels = dfr[radName].values
   begRadDist = [calculateDistVec(beginLat, beginLon, radlats, radlons, radlabels, 500)
                if not pd.isnull(beginLat) else np.nan for beginLat, beginLon in zip(tqdm(df["beginLatitude"]),df["beginLongitude"])]
   endRadDist = [calculateDistVec(endLat, endLon, radlats, radlons, radlabels, 500)
                if not pd.isnull(endLat) else np.nan for endLat, endLon in zip(tqdm(df["endLatitude"]),df["endLongitude"])]

   if checkValidRadar:
      print("Filtering out invalid radars (4):")
      begRadValid = [np.array(dfr.loc[(dfr["first_date"] <= int(btime[:8])) & (dfr["last_date"] >= int(btime[:8])), "icao"].values) for btime in tqdm(df["beginTimestamp"])]
      endRadValid = [np.array(dfr.loc[(dfr["first_date"] <= int(etime[:8])) & (dfr["last_date"] >= int(etime[:8])), "icao"].values) for etime in tqdm(df["endTimestamp"])]
      begRadDist = [radarArray[np.isin(radarArray[:, 1], validRads)] if isinstance(radarArray, np.ndarray) else np.nan
                    for radarArray, validRads in zip(tqdm(begRadDist), begRadValid)]
      endRadDist = [radarArray[np.isin(radarArray[:, 1], validRads)] if isinstance(radarArray, np.ndarray) else np.nan
                    for radarArray, validRads in zip(tqdm(endRadDist), endRadValid)]
   isdualpol = np.array([False for _ in begRadDist])
   if dualpolInfo:
      print("Checking for dual-pol data (0-2)...")
      years = np.unique(np.array([int(t[:4]) for t in df["beginYear"]]))
      if all(year < 2011 for year in years):
         isdualpol = np.array([False for x in begRadDist])
         dualpolInfo = False
      elif all(year > 2014 for year in years):
         isdualpol = np.array([True for x in begRadDist])
         dualpolInfo = False
      else:
         begRadValid = [np.array(dfr.loc[(dfr["dualpol_date"] <= int(btime[:8])), "icao"].values) for btime in tqdm(df["beginTimestamp"])]
         endRadValid = [np.array(dfr.loc[(dfr["dualpol_date"] <= int(etime[:8])), "icao"].values) for etime in tqdm(df["endTimestamp"])]
         begisdualpol = np.array([(begRadarArray.shape[0] > 0 and begRadarArray[0, 1] in begValidRads)
                               if isinstance(begRadarArray, np.ndarray) else False
                               for begRadarArray, begValidRads in zip(begRadDist, begRadValid)])
         endisdualpol = np.array([(endRadarArray.shape[0] > 0 and endRadarArray[0, 1] in endValidRads)
                               if isinstance(endRadarArray, np.ndarray) else False
                               for endRadarArray, endValidRads in zip(endRadDist, endRadValid)])
         isdualpol = np.array([b and e for b, e in zip(begisdualpol, endisdualpol)])

   df["beginRadar"] = [rads[0][1] if isinstance(rads, np.ndarray) and len(rads) > 0 else np.nan for rads in begRadDist]
   df["beginRange"] = [round(rads[0][0], 3) if isinstance(rads, np.ndarray) and len(rads) > 0 else np.nan for rads in begRadDist]
   df["endRadar"]   = [rads[0][1] if isinstance(rads, np.ndarray) and len(rads) > 0 else np.nan for rads in endRadDist]
   df["endRange"]   = [round(rads[0][0], 3) if isinstance(rads, np.ndarray) and len(rads) > 0 else np.nan for rads in endRadDist]
   df["dualpol"]    = [1 if d else 0 for d in isdualpol]

   if dualPol:
      print("Number of reports before dual-pol filter:")
      print(len(df))
      outputFile += "_Dual-pol_Only"
      keep_mask = np.array(isdualpol, dtype=bool)
      df = df.loc[keep_mask].copy()
      begRadDist = [x for x, y in zip(begRadDist, keep_mask) if y]
      endRadDist = [x for x, y in zip(endRadDist, keep_mask) if y]
      isdualpol = isdualpol[keep_mask]
      if dualpolInfo and 'begRadValid' in locals() and 'endRadValid' in locals():
         begRadValid = [x for x, y in zip(begRadValid, keep_mask) if y]
         endRadValid = [x for x, y in zip(endRadValid, keep_mask) if y]

   for col in np.array(["oneTorID", "multiSegment", "tornadoBeginTime", "tornadoEndTime", "totalDurationMin", "maxMagnitudeAcrossSeg", "totalTornadoLength", "maxTornadoWidth"]):
      df[col] = np.nan
   for col in np.array(["injuriesDirect", "injuriesIndirect", "deathsDirect", "deathsIndirect", "damageProperty", "damageCrops"]):
      df["total" + col[0].upper() + col[1:]] = np.nan

   if onetor:
      # Compute distance matrix between all start and end points
      print("Grouping tornado report segments:")
      dftor = df.query("tornado == 1").copy()
      endlats  = dftor["endLatitude"].values
      endlons  = dftor["endLongitude"].values
      idlabels = dftor["stormEventsReportID"].values
      
      iddists = [calculateDistVec(lat, lon, endlats, endlons, idlabels, 1) for lat, lon in zip(tqdm(dftor["beginLatitude"]), dftor["beginLongitude"])]
      tor_ids = dftor["stormEventsReportID"].values
      begin_map = dftor.set_index("stormEventsReportID")["beginUnix"].to_dict()
      end_map = dftor.set_index("stormEventsReportID")["endUnix"].to_dict()
      county_map = dftor.set_index("stormEventsReportID")["county"].to_dict()

      # Build all valid predecessor candidates for each segment.
      # Tie handling: candidates are ranked by (smallest time gap, smallest distance, smallest ID)
      # and each predecessor can only be assigned to one successor.
      candidate_prev = {cur: [] for cur in tor_ids}
      for dist, cur in zip(iddists, tor_ids):
         if len(dist) == 0:
            continue
         cur_begin = begin_map.get(cur, np.nan)
         cur_end = end_map.get(cur, np.nan)
         cur_county = county_map.get(cur, np.nan)
         if pd.isnull(cur_begin) or pd.isnull(cur_end):
            continue
         for d in dist:
            prev = d[1]
            if prev == cur:
               continue
            prev_end = end_map.get(prev, np.nan)
            prev_county = county_map.get(prev, np.nan)
            if pd.isnull(prev_end):
               continue

            time_gap = cur_begin - prev_end
            valid_time = (0 <= time_gap <= 60)
            valid_tie = ((cur_end != end_map.get(prev, np.nan))
                         or (cur_begin == prev_end and prev < cur))
            valid_county = (prev_county != cur_county)

            if valid_time and valid_tie and valid_county:
               candidate_prev[cur].append((prev, float(d[0]), time_gap))

      for cur in candidate_prev.keys():
         candidate_prev[cur] = sorted(candidate_prev[cur], key=lambda x: (x[2], x[1], x[0]))

      # One-to-one matching prevents branching artifacts in ties.
      segids = {}
      used_prev = set()
      assign_order = sorted(tor_ids, key=lambda x: (begin_map.get(x, np.inf), x))
      for cur in assign_order:
         for prev, _, _ in candidate_prev.get(cur, []):
            if prev not in used_prev:
               segids[cur] = prev
               used_prev.add(prev)
               break

      previous_segment = [segids.get(id, np.nan) for id in dftor["stormEventsReportID"]]
      df.loc[dftor.index, "previousSegment"] = previous_segment

      # Root + segment number from predecessor chain.
      def _root_and_depth(seg_id):
         depth = 1
         cur = seg_id
         seen = set()
         while cur in segids and cur not in seen:
            seen.add(cur)
            cur = segids[cur]
            depth += 1
         return cur, depth

      roots_depths = [_root_and_depth(seg_id) for seg_id in dftor["stormEventsReportID"]]
      roots = [rd[0] for rd in roots_depths]
      segnums = [rd[1] for rd in roots_depths]
      chain_sizes = pd.Series(roots).value_counts().to_dict()

      dftor["oneTorID"] = roots
      df.loc[dftor.index, "oneTorID"] = dftor["oneTorID"]
      df.loc[dftor.index, "segmentNumber"] = segnums
      df.loc[dftor.index, "multiSegment"] = [1 if chain_sizes.get(root, 0) > 1 else 0 for root in roots]
      starttimes = dftor.groupby("oneTorID")["beginUnix"].transform(lambda x: x.min() if not x.isnull().all() else np.nan)
      endtimes   = dftor.groupby("oneTorID")["endUnix"].transform(lambda x: x.max() if not x.isnull().all() else np.nan)
      df["tornadoBeginTime"] = df["tornadoBeginTime"].astype(object)
      df["tornadoEndTime"]   = df["tornadoEndTime"].astype(object)
      df["maxMagnitudeAcrossSeg"] = df["maxMagnitudeAcrossSeg"].astype(object)
      df.loc[dftor.index, "tornadoBeginTime"] = [datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y%m%d-%H%M") for t in starttimes]
      df.loc[dftor.index, "tornadoEndTime"]   = [datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y%m%d-%H%M") for t in endtimes]
      df.loc[dftor.index, "totalDurationMin"] = (endtimes - starttimes) / 60
      dftor["magnitude"] = [int(x) if str(x) not in ("U", "", "nan") and not pd.isnull(x) else -1 for x in dftor["magnitude"]]
      dftor["maxMagnitudeAcrossSeg"] = dftor.groupby("oneTorID")["magnitude"].transform(lambda x: x.max() if not x.isnull().all() else np.nan)
      df.loc[dftor.index, "maxMagnitudeAcrossSeg"] = dftor["maxMagnitudeAcrossSeg"].replace(-1, "U")
      df.loc[dftor.index, "totalTornadoLength"]    = dftor.groupby("oneTorID")["tornadoLength"].transform(lambda x: round(x.sum(), 2) if not x.isnull().all() else np.nan)
      df.loc[dftor.index, "maxTornadoWidth"] = dftor.groupby("oneTorID")["tornadoWidth"].transform(lambda x: x.max() if not x.isnull().all() else np.nan)
      
      print("Adding totals for multisegment tornadoes:")
      for col in tqdm(np.array(["injuriesDirect", "injuriesIndirect", "deathsDirect", "deathsIndirect", "damageProperty", "damageCrops"])):
         # for x in dftor["oneTorID"]:
         #    if type(x) != int: print(x)
         try:
            total = dftor.groupby("oneTorID")[col].transform(lambda x: round(x.sum(), 2) if not x.isnull().all() else np.nan)
         except:
            for x in dftor[col].values:
               if type(x) == str: print(x)
            exit()
         df.loc[dftor.index, "total" + col[0].upper() + col[1:]] = total
      print("IDs that were not captured as multi-segment (need QC):")
      segs = dfs[~pd.isnull(dfs["TOR_OTHER_CZ_FIPS"])]["EVENT_ID"].values
      noncap = [int(s) for s in segs if s not in df[df["multiSegment"] == 1]["stormEventsReportID"].values]
      print(noncap)

   df["magnitude"] = df["magnitude"].replace(-1, "U")

   if dualpolInfo:
      print("Calculating dual-pol radar distances (2):")
      begRadDisteg = [radarArray[np.isin(radarArray[:, 1], validRads)][0] if not d and isinstance(radarArray, np.ndarray) and len(radarArray) > 0 and any(np.isin(radarArray[:, 1], validRads)) else np.nan
                      for radarArray, validRads, d in zip(tqdm(begRadDist), begRadValid, isdualpol)]
      endRadDistnd = [radarArray[np.isin(radarArray[:, 1], validRads)][0] if not d and isinstance(radarArray, np.ndarray) and len(radarArray) > 0 and any(np.isin(radarArray[:, 1], validRads)) else np.nan
                      for radarArray, validRads, d in zip(tqdm(endRadDist), endRadValid, isdualpol)]
      df["dualpolBeginRadar"] = [rads[1] if isinstance(rads, np.ndarray) and len(rads) > 0 and rads[0] <= 300 else np.nan for rads in begRadDisteg]
      df["dualpolBeginRange"] = [round(rads[0], 3) if isinstance(rads, np.ndarray) and len(rads) > 0 and rads[0] <= 300 else np.nan for rads in begRadDisteg]
      df["dualpolEndRadar"]   = [rads[1] if isinstance(rads, np.ndarray) and len(rads) > 0 and rads[0] <= 300 else np.nan for rads in endRadDistnd]
      df["dualpolEndRange"]   = [round(rads[0], 3) if isinstance(rads, np.ndarray) and len(rads) > 0 and rads[0] <= 300 else np.nan for rads in endRadDistnd]
      df["dualpolNotNearest"] =  [1 if not pd.isnull(b) and not pd.isnull(e) else 0 for b, e in zip(df["dualpolBeginRadar"], df["dualpolEndRadar"])]
   else:
      df["dualpolBeginRadar"] = np.nan
      df["dualpolBeginRange"] = np.nan
      df["dualpolEndRadar"]   = np.nan
      df["dualpolEndRange"]   = np.nan
      df["dualpolNotNearest"] = 0
   if onetor: idCol = "oneTorID"
   else: idCol = "stormEventsReportID"
   
   if preTorDir:
      if path.isdir(preTorDir):
         files = listdir(preTorDir)
         if ".DS_Store" in files: files.remove(".DS_Store")
         files.sort()
         dfpre = pd.DataFrame()
         dfs = [pd.read_csv("{}/{}".format(preTorDir, file), encoding="utf8", na_values=[-99900,"-99900"], low_memory=False)
             for file in files if file[-4:] == ".csv"]
         dfpre = pd.concat(dfs, ignore_index=True)
      else:
         try:
            dfpre = pd.read_csv(preTorDir, encoding="utf8", low_memory=False)
         except OSError as err:
            print("Error reading pre-tornadic file \"{}\". Error:\n{}\n".format(preTorDir, err), flush=True)
            exit()

         dfpre.dropna(axis = 0, how = "all", inplace = True)

      tpe = [dfpre["stormType"][dfpre["tornadoID"] == id].values[-1] if id in dfpre["tornadoID"].values else st for st, id in zip(df["stormType"], df[idCol])]
      sid = [dfpre["stormID"][dfpre["tornadoID"] == id].values[0] if id in dfpre["tornadoID"].values else st for st, id in zip(df["stormID"], df[idCol])]
      df["stormID"]   = sid
      df["stormType"] = tpe
      pretracked = dfpre["tornadoID"].unique()
      df["preTornadoTracked"] = [1 if ((id in pretracked) or (tr == 1)) else 0 if to else np.nan for id, tr, to in zip(df[idCol], df["preTornadoTracked"], df["tornado"])]
      prelats  = dfpre["latitude"].values
      prelons  = dfpre["longitude"].values
      labels = np.array(["{}_{}".format(t, id) for t, id in zip(dfpre["unixTime"], dfpre["stormID"])])
      ntdists = [calculateDistVec(lat, lon, prelats, prelons, labels, 10) if tor == 0 else [] for lat, lon, tor in zip(tqdm(df["beginLatitude"]), df["beginLongitude"], df["tornado"])]
      pretor  = [[d[1][d[1].find('_')+1:] for d in dist if abs(int(d[1][:d[1].find('_')]) - t) <= 600] if len(dist) > 0 else [] for dist, t in zip(ntdists, df["beginUnix"])]
      df["stormID"] = [d[0] if len(d) > 0 else id for d, id in zip(pretor, df["stormID"])]
      df["QCd"]       = [-1 if qc == -1 else 1 if ((id in pretracked) or (qc == 1)) else 0 for id, qc in zip(df[idCol], df["QCd"])]
      df["corrected"] = [0 if ((pd.isnull(co)) and (qc == 1)) else co for co, qc in zip(df["corrected"], df["QCd"])]

   if stormModeFile:
      try:
         print("Adding storm mode info...")
         dfsm = pd.read_csv(stormModeFile, encoding="latin1", na_values=[-99900,"-99900"], low_memory=False)

         # Parse date + time columns into a UTC unix timestamp for matching
         def _parse_sm_unix(row):
            try:
               dt_str = "{} {}".format(row["date"].strip(), row["time"].strip())
               dt = datetime.datetime.strptime(dt_str, "%m/%d/%Y %I:%M:%S %p")
               return int(timegm(dt.timetuple()))
            except Exception:
               return np.nan
         dfsm["_smUnix"] = dfsm.apply(_parse_sm_unix, axis=1)
         dfsm["_smWidth"] = pd.to_numeric(dfsm["width_yards"], errors="coerce")
         dfsm["_smMag"]   = pd.to_numeric(dfsm["magnitude"],   errors="coerce")
         dfsm["_smCounty"] = dfsm["county"].str.strip().str.lower() if "county" in dfsm.columns else ""

         sm_mode_cols = ["discrete", "cell in line", "cell in cluster", "qlcs", "bow echo", "cluster", "super RM", "super LM", "TC", "mrgl supercell", "hybrid","disorg (cell or cluster)"]
         sm_mode_cols = [c for c in sm_mode_cols if c in dfsm.columns]
         sm_mode_labels = {"discrete": "Discrete",
                           "cell in line": "Cell in Line",
                           "cell in cluster": "Cell in Cluster",
                           "qlcs": "QLCS",
                           "bow echo": "Bow echo",
                           "cluster": "Cluster",
                           "super RM": "Supercell RM",
                           "super LM": "Supercell LM",
                           "TC": "TC",
                           "mrgl supercell": "Marginal Supercell",
                           "hybrid": "Hybrid",
                           "disorg (cell or cluster)": "Disorganized"}

         def _is_one(value):
            try:
               return pd.notnull(value) and float(value) == 1
            except (TypeError, ValueError):
               return False

         def _get_storm_mode_fallback(existing_type):
            if pd.isnull(existing_type):
               return None
            existing_type = str(existing_type).strip()
            if existing_type == "Supercell":
               return ("Discrete", "Supercell", 31)
            if existing_type == "Ordinary":
               return ("Discrete", "Disorganized", 51)
            return None

         if "stormType" not in df.columns:
            df["stormType"] = pd.Series([pd.NA] * len(df), dtype="object")
         if "stormMode" not in df.columns:
            df["stormMode"] = pd.Series([pd.NA] * len(df), dtype="object")
         if "stormModeCode" not in df.columns:
            df["stormModeCode"] = np.nan
         if "RMLM" not in df.columns:
            df["RMLM"] = pd.Series([pd.NA] * len(df), dtype="object")
         if "stormModeSummary" not in df.columns:
            df["stormModeSummary"] = pd.Series([pd.NA] * len(df), dtype="object")
         if "stormModeReportID" not in df.columns:
            df["stormModeReportID"] = pd.Series([pd.NA] * len(df), dtype="object")

         # Ensure text columns can safely receive string assignments.
         for text_col in ["stormType", "stormMode", "RMLM", "stormModeSummary", "stormModeReportID", "TCname", "stormID", "QCnotes", "autoQCnotes"]:
            if text_col in df.columns:
               df[text_col] = df[text_col].astype("object")

         df["_dfWidth"] = pd.to_numeric(df["tornadoWidth"], errors="coerce")
         df["_dfMag"]   = pd.to_numeric(df["magnitude"].replace("U", np.nan), errors="coerce")
         df["_dfCounty"] = df["county"].str.strip().str.lower()

         print("Matching storm mode records:")
         matched = 0
         for df_idx, df_row in tqdm(df.iterrows(), total=len(df)):
            if pd.isnull(df_row["beginUnix"]):
               continue
            existing_type = df.at[df_idx, "stormType"]
            existing_type_is_tc = (not pd.isnull(existing_type)) and (str(existing_type).strip() == "TC")
            # Candidate storm mode rows: within 5 minutes, same county
            time_match   = (dfsm["_smUnix"] - df_row["beginUnix"]).abs() <= 300
            county_match = dfsm["_smCounty"] == df_row["_dfCounty"]
            candidates   = dfsm[time_match & county_match].copy()
            if candidates.empty:
               fallback = _get_storm_mode_fallback(existing_type)
               if fallback:
                  df.at[df_idx, "stormType"] = fallback[0]
                  df.at[df_idx, "stormMode"] = fallback[1]
                  df.at[df_idx, "stormModeCode"] = fallback[2]
               continue
            # Score by width and magnitude closeness
            candidates["_score"] = 0
            if not pd.isnull(df_row["_dfWidth"]):
               candidates["_score"] += (candidates["_smWidth"] - df_row["_dfWidth"]).abs().fillna(9999)
            if not pd.isnull(df_row["_dfMag"]):
               candidates["_score"] += (candidates["_smMag"] - df_row["_dfMag"]).abs().fillna(9999)
            best_idx = candidates["_score"].idxmin()
            sm_row = candidates.loc[best_idx]
            active_modes = [mc for mc in sm_mode_cols if _is_one(sm_row[mc])]
            mode_summary = "; ".join(sm_mode_labels.get(mc, mc) for mc in active_modes) if active_modes else np.nan
            report_id = sm_row["report_id"] if "report_id" in sm_row.index else np.nan
            storm_type = np.nan
            storm_mode = np.nan
            storm_mode_code = np.nan
            rm_lm = np.nan

            if not active_modes:
               fallback = _get_storm_mode_fallback(existing_type)
               if fallback:
                  storm_type, storm_mode, storm_mode_code = fallback

            has_tc = "TC" in active_modes
            has_discrete = "discrete" in active_modes
            has_cell_in_line = "cell in line" in active_modes
            has_cell_in_cluster = "cell in cluster" in active_modes
            has_qlcs = "qlcs" in active_modes
            has_bow = "bow echo" in active_modes
            has_cluster = "cluster" in active_modes
            has_super_rm = "super RM" in active_modes
            has_super_lm = "super LM" in active_modes
            has_supercell = has_super_rm or has_super_lm
            has_explicit_hybrid = "hybrid" in active_modes
            has_explicit_marginal = "mrgl supercell" in active_modes
            has_explicit_disorganized = "disorg (cell or cluster)" in active_modes

            if has_super_rm and has_super_lm:
               rm_lm = "RM/LM"
            elif has_super_rm:
               rm_lm = "RM"
            elif has_super_lm:
               rm_lm = "LM"

            linear_mode = has_qlcs or has_bow or has_cell_in_line
            discrete_mode = has_discrete
            cluster_mode = has_cluster or has_cell_in_cluster

            if has_qlcs and has_bow:
               storm_type = "Linear"
               storm_mode = "Bow echo"
               storm_mode_code = 12
            elif has_qlcs and not (has_supercell or has_explicit_hybrid or has_cell_in_line):
               storm_type = "Linear"
               storm_mode = "QLCS"
               storm_mode_code = 11
            elif linear_mode and has_explicit_hybrid:
               storm_type = "Linear"
               storm_mode = "Hybrid"
               storm_mode_code = 22 if has_cell_in_line else 21
            elif has_cell_in_line:
               storm_type = "Linear"
               if has_explicit_marginal:
                  storm_mode = "Marginal"
                  storm_mode_code = 43
               elif has_supercell:
                  storm_mode = "Supercell"
                  storm_mode_code = 33
               elif has_cell_in_line:
                  storm_mode = "Hybrid"
                  storm_mode_code = 22
               else:
                  storm_mode = "Disorganized"
                  storm_mode_code = 53
            elif discrete_mode:
               storm_type = "Discrete"
               if has_explicit_marginal:
                  storm_mode = "Marginal"
                  storm_mode_code = 41
               elif has_supercell:
                  storm_mode = "Supercell"
                  storm_mode_code = 31
               else:
                  storm_mode = "Disorganized"
                  storm_mode_code = 51
            elif cluster_mode:
               storm_type = "Cluster"
               if has_explicit_marginal:
                  storm_mode = "Marginal"
                  storm_mode_code = 42
               elif has_supercell:
                  storm_mode = "Supercell"
                  storm_mode_code = 32
               else:
                  storm_mode = "Disorganized"
                  storm_mode_code = 52
            elif has_explicit_disorganized:
               if has_cluster or has_cell_in_cluster:
                  storm_type = "Cluster"
                  storm_mode = "Disorganized"
                  storm_mode_code = 52 if has_cell_in_cluster else 53
               elif has_discrete:
                  storm_type = "Discrete"
                  storm_mode = "Disorganized"
                  storm_mode_code = 51

            if existing_type_is_tc or has_tc:
               storm_type = "TC"

            df.at[df_idx, "stormType"] = storm_type
            df.at[df_idx, "stormMode"] = storm_mode
            df.at[df_idx, "stormModeCode"] = storm_mode_code
            df.at[df_idx, "RMLM"] = rm_lm
            df.at[df_idx, "stormModeSummary"] = mode_summary
            df.at[df_idx, "stormModeReportID"] = report_id
            matched += 1
         print(f"Matched {matched} of {len(df)} storm mode records.")
         df.drop(columns=["_dfWidth", "_dfMag", "_dfCounty"], inplace=True)
      except OSError as err:
         print("Something is wrong with the storm mode file {}:\n{}\nSkipping adding storm mode info.".format(stormModeFile, err))

   if LSRTextFolder:
      years = sorted(pd.unique(pd.concat([df["beginYear"], df["endYear"]])))
      allfiles = [f for year in years for f in sorted(glob.glob(f"{LSRTextFolder}/{year}/*.txt"))]
      print(f"Processing {len(allfiles)} LSR files:")
      allLsrs = []
      for f in tqdm(allfiles):
         try:
            with open(f, 'r', encoding='utf-8', errors='ignore') as file:
               lsrs = parseLSR(file.read())
               if lsrs:
                  allLsrs.extend(lsrs)
         except Exception as e:
            continue
      lsrDf = pd.DataFrame(allLsrs)
      if not lsrDf.empty:
         # Keep earliest issued time per matching key to avoid expensive exploded merges.
         lsrDf["beginLatitude"] = lsrDf["latitude"].astype(float)
         lsrDf["beginLongitude"] = lsrDf["longitude"].astype(float)
         lsrDf["beginTimestamp"] = lsrDf["timestamp"]
         df["beginLatitude"] = df["beginLatitude"].astype(float)
         df["beginLongitude"] = df["beginLongitude"].astype(float)
         join_cols = ["beginLatitude", "beginLongitude", "beginTimestamp", "severeType"]
         lsrBest = (lsrDf.sort_values("issuedUnix")
                    .drop_duplicates(subset=join_cols, keep="first")[join_cols + ["issuedUnix"]])

         df = pd.merge(df, lsrBest, on=join_cols, how="left")
         print(f"Total reports: {len(df)}")
         df["issuedTimeDiff"] = (df["issuedUnix"] - df["beginUnix"]) / 60
         print(f"Final reports: {len(df)}")
         print(f"Non-matched reports: {int(df['issuedUnix'].isna().sum())}")
         print(int(df["issuedUnix"].notna().sum()))
      else:
         df["issuedUnix"] = pd.NA
         df["issuedTimeDiff"]  = pd.NA
   else:
      df["issuedUnix"] = pd.NA
      df["issuedTimeDiff"]  = pd.NA
   
   df = df[["beginTimestamp","beginYear","beginMonth","beginDay","beginTime","beginUnix","beginTimestampLocal","beginLongitude",
            "beginLatitude","endTimestamp","endYear","endMonth","endDay","endTime","endUnix","endTimestampLocal","endLongitude",
            "endLatitude","durationMin","issuedUnix","issuedTimeDiff","tornado","spout","anticyclonic","hail","wind","severeType","magnitude",
            "magnitudeType","type","tornadoLength","tornadoWidth","injuriesDirect","injuriesIndirect",
            "deathsDirect","deathsIndirect","damageProperty","damageCrops","source","overview","details",
            "stormEventsEpisodeID","stormEventsReportID","oneTorID","multiSegment","previousSegment", "segmentNumber",
            "tornadoBeginTime", "tornadoEndTime", "totalDurationMin","maxMagnitudeAcrossSeg","totalTornadoLength","maxTornadoWidth",
            "totalInjuriesDirect","totalInjuriesIndirect","totalDeathsDirect","totalDeathsIndirect",
            "totalDamageProperty","totalDamageCrops","preTornadoTracked","stormID","stormModeReportID","stormType","stormMode",
            "stormModeCode","RMLM","stormModeSummary","TCname","county","state","CWA","NWSRegion","dualpol","beginRadar","beginRange",
            "endRadar","endRange", "dualpolBeginRadar","dualpolBeginRange", "dualpolEndRadar", "dualpolEndRange", "dualpolNotNearest",
            "QCd","corrected","QCnotes","autoQCnotes"]]
   df.sort_values(by=["beginTimestamp"], inplace=True)
   df["tempID"] = [id2 if pd.isnull(id1) else id1 for id1, id2 in zip(df["oneTorID"], df["stormEventsReportID"])]
   df["temp"] = [df[df["tempID"] == id]["beginUnix"].values[0] for id in df["tempID"]]
   df.sort_values(by=["temp", "tempID", "segmentNumber"], inplace=True)
   df.drop(labels=["temp", "tempID"],axis=1,inplace=True)
   print("Removing long-duration reports:")
   print(df[(df["durationMin"] > 300) & (df["tornado"] != 1)][["beginTimestamp","beginLongitude",
            "beginLatitude","endTimestamp","endLongitude","endLatitude","durationMin","type"]])
   long_duration_removed_ids = set(df.loc[((df["durationMin"] > 300) & (df["tornado"] != 1)), "stormEventsReportID"].values)
   df = df[~((df["durationMin"] > 300) & (df["tornado"] != 1))]
   # Write out dataframe to csv
   print("Writing out data...")
   df.to_csv(path_or_buf = str("{}/{}.csv".format(outputDir,outputFile)), index=False, na_rep=-99900)
   print("Done!")
   return 0

def getTZoffset(timeZone):
   if timeZone[-3:].isdigit() or (timeZone[-3] in ["+", '-'] and timeZone[-2:].isdigit()):
      return int(timeZone[-3:])
   elif timeZone[-2:].isdigit() or (timeZone[-2] in ["+", '-'] and timeZone[-1].isdigit()):
      return int(timeZone[-2:])
   else:
      timezone_offsets = {
      "UTC": 0, "GMT": 0,  # Coordinated Universal Time (UTC), Greenwich Mean Time (GMT)
      "EST": -5, "EDT": -4,  # Eastern Standard Time, Eastern Daylight Time (during daylight saving)
      "CSC": -6, "SCT": -6, # Misspelling of Central Standard Time
      "CST": -6, "CDT": -5,  # Central Standard Time, Central Daylight Time
      "MST": -7, "MDT": -6,  # Mountain Standard Time, Mountain Daylight Time
      "PST": -8, "PDT": -7,  # Pacific Standard Time, Pacific Daylight Time
      "AKST": -9, "AKDT": -8,  # Alaska Standard Time, Alaska Daylight Time
      "HST": -10,  # Hawaii-Aleutian Standard Time
      "SST": -11,  # Samoa Standard Time
      "CHST": 10, "GST": 10,  # Chamorro Standard Time (Guam, CNMI)
      "AST": -4,  "ADT": -3,   # Atlantic Standard Time, # Atlantic Daylight Time (used in Puerto Rico, US Virgin Islands)
      "UNK": 0}
      if timeZone.upper() in timezone_offsets:
         return timezone_offsets[timeZone.upper()]
      else:
         print("Could not find timezone {}. Fix code to handle it. Exiting.".format(timeZone))
         exit()

timeReg = re.compile(r"\n(\d{1,2})(\d{2}) {1,2}(am|pm) {2,}", flags=re.IGNORECASE)
typeReg = re.compile(r" (?:am|pm) {2,}((?:[a-z]+(?:-[a-z]+| [a-z]+){0,3})) ", flags=re.IGNORECASE)
latlonReg = re.compile(r"(\d{2}\.\d{1,3})(N|S)\s+(\d{2,3}\.\d{1,3})(W|E)", flags=re.IGNORECASE)
dateReg = re.compile(r"\n(\d{1,2})\s?\/\s?(\d{1,2})\/\s?(\d{4})", flags=re.IGNORECASE)
issuedReg = re.compile(r"(\d{1,2})(\d{0}|\d{2})\s?(am|pm)\s([a-z]{3,4})\s?(?:\(\d{1,2}\d{0}|\d{2}\s?(?:am|pm)\s[a-z]{3,4}\))?\s[a-z]{3}\s([a-z]{3})\s(\d{1,2})\s(\d{4})", flags=re.IGNORECASE)
azReg = re.compile("national\sweather\sservice\s\w+\sAZ", flags=re.IGNORECASE)
timezonePytz={
   "UTC":"UTC","GMT":"Etc/GMT","EST":"America/New_York","EDT":"America/New_York",
   "CST":"America/Chicago","CDT":"America/Chicago","CSC":"America/Chicago",
   "MST":"America/Denver","MSTA":"US/Arizona","MDT":"America/Denver",
   "PST":"America/Los_Angeles","PDT":"America/Los_Angeles","AKST":"America/Anchorage",
   "AKDT":"America/Anchorage","HST":"Pacific/Honolulu","SST":"Pacific/Pago_Pago",
   "CHST":"Pacific/Guam","GST":"Pacific/Guam","AST":"America/Puerto_Rico",
   "ADT":"America/Halifax","UNK":"UTC"
}
typeoptions = ["TORNADO","HAIL","MARINE HAIL","TSTM WND DMG","TSTM WND GST","MARINE TSTM WIND","WATER SPOUT", "WATERSPOUT"]
svr = ["TORNADO","HAIL","MARINE HAIL","TSTM WND DMG","TSTM WND GST","MARINE TSTM WIND","WATER SPOUT", "WATERSPOUT"]

def parseLSR(text):
   try:
      subtxt = text[text.find("..REMARKS.."):text.find("&&")].strip() if "..REMARKS.." in text and "&&" in text else text
      typesOrig = [t.upper() for t in re.findall(typeReg, subtxt)]
      types = ["Tornado" if t in svr and "WATER" in t else "Wind" if t in svr and ("WND" in t or "WIND" in t) else "Hail" if t in svr and "HAIL" in t else t.capitalize() if t in svr else None for t in typesOrig]
      if not [t for t in types if t]:
         return []
      dates = [dict(zip(["month", "day", "year"], m.groups())) for m in dateReg.finditer(subtxt)]
      times = [dict(zip(["hour", "minute", "ampm"], m.groups())) for m in timeReg.finditer(subtxt)]
      latlon = [dict(zip(["latitude", "SorN", "longitude", "WorE"], m.groups())) for m in latlonReg.finditer(subtxt)]
      try:
         [h, m, ampm, tz, mon, day, yr] = issuedReg.search(text).groups()
      except:
         return []
      isAz = bool(azReg.search(text))
      tzInfo = pytz.timezone(timezonePytz["MSTA"] if isAz else timezonePytz.get(tz, "UTC"))
      issueLocalDt = tzInfo.localize(datetime.datetime.strptime(f"{h.zfill(2)}:{m} {ampm} {mon} {day} {yr}", "%I:%M %p %b %d %Y"))
      issuedDateUtc = issueLocalDt.astimezone(pytz.utc)
      issuedStr  = issuedDateUtc.strftime("%Y%m%d-%H%M")
      issuedUnix = int(issuedDateUtc.timestamp())
      localDts = [tzInfo.localize(datetime.datetime.strptime(f"{d['month']}/{d['day']}/{d['year']} {r['hour']}:{r['minute']} {r['ampm'].upper()}", "%m/%d/%Y %I:%M %p")) for r, d in zip(times, dates)]
      utcDts = [dt.astimezone(pytz.utc) for dt in localDts]
      utcStrs = [dt.strftime("%Y%m%d-%H%M") for dt in utcDts]
      unixTimes = [int(dt.timestamp()) for dt in utcDts]
      if len(utcStrs) != len(types) or len(dates) != len(times) or len(latlon) != len(types):
         return []
      return [{"timestamp": utcStrs[idx],
               "timeUnix": unixTimes[idx],
               "issuedTimestamp": issuedStr,
               "issuedUnix": issuedUnix,
               "severeType": types[idx],
               "latitude": float(latlon[idx]["latitude"]) if latlon[idx]["SorN"] == "N" else -float(latlon[idx]["latitude"]),
               "longitude": -float(latlon[idx]["longitude"]) if latlon[idx]["WorE"] == "W" else float(latlon[idx]["longitude"])} for idx, t in enumerate(types) if t]
   except Exception as e:
      return []


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

def readRadarCSV(radarFile, latName = '', lonName = '', radName = ''):
   try:
      dfr = pd.read_csv(radarFile, encoding = "utf8", na_values=[-99900, "-99900"])
   except OSError as err:
      print("Unable to read radar file {}.".format(radarFile, err))
      sys.exit(1)
   if latName:
      latName = latName.lower()
   if lonName:
      lonName = lonName.lower()
   if radName:
      radName = radName.lower()
   dfr.columns = dfr.columns.str.lower()
   if "network" in dfr.columns:
      dfr = dfr.query("network == 'NEXRAD'")
   latNames = [latName, "lat", "latitude", "lats", "latitudes"]
   lonNames = [lonName, "lon", "longitude", "lons", "longitudes"]
   radNames = [radName, "icao", "rda_id"]
   latName = next((key for key in latNames if key != '' and key in dfr), None)
   lonName = next((key for key in lonNames if key != '' and key in dfr), None)
   radName = next((key for key in radNames if key != '' and key in dfr), None)
   if not latName:
      print("Latitude column not found in {}.".format(radarFile))
      sys.exit(1)
   if not lonName:
      print("Longitude column not found in {}.".format(radarFile))
      sys.exit(1)
   if not radName:
      print("Radar ID column not found in {}.".format(radarFile))
      sys.exit(1)
   dualpol = True
   if "dualpol_date" not in dfr.columns:
      dualpol = False
      print("Cannot find DUALPOL_DATE in columns in {}.\nTurning off dual-pol filtering.".format(radarFile))
   return dfr, latName, lonName, radName, dualpol

# Function to compare rows
def summarizeRowDifferences(row1, row2, columns, source = ''):
   differences = []
   if isinstance(row1, pd.DataFrame): r1 = True
   else:                              r1 = False
   if isinstance(row2, pd.DataFrame): r2 = True
   else:                              r2 = False
   for col in columns:
      if r1: val1 = row1[col].values
      else: val1 = row1[col]
      if r2: val2 = row2[col].values
      else: val2 = row2[col]
      try:
         if r1 and r2 and len(val1) > 0 and len(val2) > 0:
            v1, v2 = val1[0], val2[0]
            both_nan = (pd.isnull(v1) if not isinstance(v1, str) else False) and (pd.isnull(v2) if not isinstance(v2, str) else False)
            if not both_nan and v1 != v2:
               differences.append(f"{col}: {v1} --> {v2}")
         elif not r1 and not r2:
            both_nan = (pd.isnull(val1) if not isinstance(val1, str) else False) and (pd.isnull(val2) if not isinstance(val2, str) else False)
            if not both_nan and not (pd.isnull(val1) if not isinstance(val1, str) else False) and not (pd.isnull(val2) if not isinstance(val2, str) else False) and val1 != val2:
               differences.append(f"{col}: {val1} --> {val2}")
      except (TypeError, ValueError):
         pass
   if differences:
      if source:
         result = source + ": " + "; ".join(differences)
      else:
         result = "; ".join(differences)
   else:
      result = np.nan
   return result

if __name__ == "__main__":    
   parser = argparse.ArgumentParser(description="Reads in StormEvent files from NCEI from a specified folder and year range and writes a comma separated .csv file to specified output directory of tornado, severe hail and severe thunderstorm wind.")
   parser.add_argument("-c", metavar="tcFile",          type=str,  nargs="?", default='',    help="Path to TC tor reports.")    
   parser.add_argument("-d", metavar="dualPol",         type=bool, nargs="?", default=False, help="Only use reports where dual-pol was available (default: False)")    
   parser.add_argument("-e", metavar="endYear",         type=int,  nargs="?", default=-1,    help="Specify end year for year range. Start year will be waht you specify in the required input.")    
   parser.add_argument("-f", metavar="timeFormat",      type=str,  nargs="?", default="%Y%m%d-%H%M", help="Time format in storm data files.")    
   parser.add_argument("-l", metavar="LSRTextFolder",   type=str,  nargs="?", default='',    help="Path to LSR report folder for finding issuance time.")    
   parser.add_argument("-n", metavar="nonSevere",       type=bool, nargs="?", default=False, help="Include non-severe reports (default: False)")    
   parser.add_argument("-o", metavar="outputFile",      type=str,  nargs="?", default='',    help="Output file name (default: [years]_Severe_Storm_Reports.csv)")    
   parser.add_argument("-p", metavar="preTorDir",       type=str,  nargs="?", default='',    help="Directory for pre-tornadic files to extract storm ID and mode from.")    
   parser.add_argument("-q", metavar="qcFile",          type=str,  nargs="?", default='',    help="Path to QCd report file for applying report corrections.")    
   parser.add_argument("-r", metavar="onetor",          type=bool, nargs="?", default=False, help="Path to SPC storm mode file.")    
   parser.add_argument("-s", metavar="stormDataPrefix", type=str,  nargs="?", default='',    help="Everything in the file name before the year (default: StormEvents_details-ftp_v1.0_d)")    
   parser.add_argument("-sm", metavar="stormModeFile",  type=str,  nargs="?", default='',    help="Everything in the file name before the year (default: StormEvents_details-ftp_v1.0_d)")    
   parser.add_argument("-y", metavar="torOnly",         type=bool, nargs="?", default=False, help="Only create tornado reports.")    
   parser.add_argument("outputDir",     type=str, nargs=1,   help="Output directory where the output file will be saved")
   parser.add_argument("radarFilePath", type=str, nargs=1,   help="Path to list of radar info")
   parser.add_argument("stormDataDir",  type=str, nargs=1,   help="Directory where storm reports are located")
   parser.add_argument("years",         type=int, nargs="+", help="Years to include for storm reports")
   args = parser.parse_args(argv[1:])

  # Check if required input paths are valid
   if not path.exists(args.stormDataDir[0]):
      print("Input directory with Storm Events Database file(s) {} does not exist. Exiting.".format(args.stormDataDir[0]))
      exit()

   if not path.exists(args.radarFilePath[0]):
      print("Input radar info file {} does not exist. Exiting.".format(args.radarFilePath[0]))
      exit()

   # Check if the output directory exists
   if not path.exists(args.outputDir[0]):
      # Ask the user if they want to create the directory
      createDir = input("The directory {} does not exist. Would you like to create it? (y/n): ".format(args.outputDir[0])).strip().lower()
      
      if createDir == "y":
         try:
            makedirs(args.outputDir[0])
            print("Directory {} created successfully.".format(args.outputDir[0]))
         except Exception as e:
            print("An error occurred while creating the directory: {}".format(e))
            exit()
      else:
         print("Directory creation was canceled. Restart with valid output directory. Exiting.")
         exit()
   if not args.e == -1 and len(args.years) == 1:
      years = list(range(args.years[0], args.e + 1))
   else:
      years = args.years

   main(years, args.stormDataDir[0], args.radarFilePath[0], args.outputDir[0],
        tcFile = args.c, dualPol = args.d, timeFormat = args.f, LSRTextFolder = args.l,
        nonsevere = args.n, outputFile = args.o, preTorDir = args.p, qcFile = args.q,
        onetor = args.r, stormDataPrefix = args.s, stormModeFile = args.sm, torOnly = args.y)