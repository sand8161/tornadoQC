#############################################################################
#
# Reads in StormEvent files from NCEI from a specified folder and year range and writes
# a comma separated .csv file to specified output directory of tornado, severe hail and severe thunderstorm wind.
# You can set a time threshold to not include severe reports within a certain time of a tornado.
#
# Example command: python createReportFile.py theas_data theas_data/radarInfo.csv ncei 1950 -e 2026 -q theas_data/1950-2026_Tornado_Reports\ -\ Corrected.csv -r True -y True
#
#############################################################################

import datetime, glob, time, sys
import numpy as np
import pandas as pd
from calendar import timegm

def main():
   years = list(range(1950, datetime.date.today().year + 1))
   dfr, latName, lonName, radName = readRadarCSV("theas_data/radarInfo.csv")
   
   dfs_list = []
   for year in years:
      try:
         stormDataFile = glob.glob("ncei/StormEvents_details-ftp_v1.0_d" + str(year) + "*")[0]
      except IndexError:
         print(f"Could not find file for year {year}. Trying a different path.")
         try:
            stormDataFile = glob.glob("ncei/*" + str(year) + "*")[0]
         except IndexError:
            print(f"Could not find any file for year {year}. Skipping.")
            continue
      try:
         dfsAdd = pd.read_csv(stormDataFile, encoding="utf8", na_values=[-99900, "-99900"], low_memory=False)
      except OSError as err:
         print(f"Error reading file {stormDataFile}:\n{err}\nExiting.")
         exit()
      dfs_list.append(dfsAdd)

   if len(dfs_list) > 0:
      dfs = pd.concat(dfs_list, ignore_index=True)
   else:
      print("No data found. Exiting.")
      exit()

   dfs["tz"] = [getTZoffset(t) for t in dfs["CZ_TIMEZONE"]]
   
   dfs = dfs.dropna(subset=['BEGIN_YEARMONTH', 'BEGIN_DAY', 'BEGIN_TIME', 'END_YEARMONTH', 'END_DAY', 'END_TIME']).copy()

   dfs["BEGIN_DATE_TIME"] = dfs["BEGIN_YEARMONTH"].astype(str).str.split('.').str[0] + \
                            dfs["BEGIN_DAY"].astype(str).str.split('.').str[0].str.zfill(2) + '-' + \
                            dfs["BEGIN_TIME"].astype(str).str.split('.').str[0].str.zfill(4).str[:4]
                            
   dfs["END_DATE_TIME"]   = dfs["END_YEARMONTH"].astype(str).str.split('.').str[0] + \
                            dfs["END_DAY"].astype(str).str.split('.').str[0].str.zfill(2) + '-' + \
                            dfs["END_TIME"].astype(str).str.split('.').str[0].str.zfill(4).str[:4]
   
   dfs["beginUTC"] = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(stime, "%Y%m%d-%H%M")) - (60*60*timeZone)))
                     for stime, timeZone in zip(dfs["BEGIN_DATE_TIME"], dfs["tz"])]
   dfs["endUTC"] = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(etime, "%Y%m%d-%H%M")) - (60*60*timeZone)))
                   for etime, timeZone in zip(dfs["END_DATE_TIME"], dfs["tz"])]
   dfs.sort_values(by=["beginUTC","endUTC"], inplace=True)
   dfs["year"] = [int(d[:4]) for d in dfs["beginUTC"]]

   df = pd.DataFrame()

   df["beginTimestamp"] = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(stime, "%Y%m%d-%H%M")) - (60*60*timeZone)))
                           for stime, timeZone in zip(dfs["BEGIN_DATE_TIME"], dfs["tz"])]
   df["beginYear"]      = np.nan
   df["beginMonth"]     = np.nan
   df["beginDay"]       = np.nan
   df["beginTime"]      = np.nan
   df["beginUnix"]      = np.nan
   df["beginTimestampLocal"] = [time.strftime("%Y%m%d-%H%M", time.strptime(stime, "%Y%m%d-%H%M")) for stime in dfs["BEGIN_DATE_TIME"]]
   df["beginLongitude"] = dfs["BEGIN_LON"].values
   df["beginLatitude"]  = dfs["BEGIN_LAT"].values
   df["endTimestamp"]   = [time.strftime("%Y%m%d-%H%M", time.gmtime(timegm(time.strptime(stime, "%Y%m%d-%H%M")) - (60*60*timeZone)))
                           for stime, timeZone in zip(dfs["END_DATE_TIME"], dfs["tz"])]
   df["endYear"]        = np.nan
   df["endMonth"]       = np.nan
   df["endDay"]         = np.nan
   df["endTime"]        = np.nan
   df["endUnix"]        = np.nan
   df["endTimestampLocal"] = [time.strftime("%Y%m%d-%H%M", time.strptime(stime, "%Y%m%d-%H%M")) for stime in dfs["END_DATE_TIME"]]
   df["endLongitude"]   = dfs["END_LON"].values
   df["endLatitude"]    = dfs["END_LAT"].values
   df["durationMin"]    = np.nan
   df["tornado"]        = [1 if event in ["Tornado", "Waterspout"] else 0 for event in dfs["EVENT_TYPE"]]
   df["spout"]          = [1 if event == "Waterspout" or (event == "Tornado" and (not pd.isnull(details) and "spout" in details.lower())) else 0 for event, details in zip(dfs["EVENT_TYPE"], dfs["EVENT_NARRATIVE"])]
   df["anticyclonic"]   = [1 if event == "Tornado" and (not pd.isnull(details) and ("anticyclonic" in details.lower() or "anti-cyclonic" in details.lower())) else 0 for event, details in zip(dfs["EVENT_TYPE"], dfs["EVENT_NARRATIVE"])]
   df["hail"]           = [1 if event == "Hail" else 0 for event in dfs["EVENT_TYPE"]]
   df["wind"]           = [1 if event == "Thunderstorm Wind" else 0 for event in dfs["EVENT_TYPE"]]
   
   sevtype = dfs["EVENT_TYPE"].copy()
   df["severeType"]     = sevtype.replace(["Thunderstorm Wind", "Waterspout"], ["Wind", "Tornado"]).values
   mags                 = [ef[-1:] if not pd.isnull(ef) else -1 if pd.isnull(mag) and pd.isnull(ef) else mag if ((tor != 1) and (mag != 0)) else -1 for mag, ef, tor in zip(dfs["MAGNITUDE"], dfs["TOR_F_SCALE"], df["tornado"])]
   df["magnitude"]      = [m if m != "U" else -1 for m in mags]
   df["magnitudeType"]  = [m if t == 0 else pd.NA for m, t in zip(dfs["MAGNITUDE_TYPE"], df["tornado"])]
   
   df["tornadoLength"]    = dfs["TOR_LENGTH"].values
   df["tornadoWidth"]     = dfs["TOR_WIDTH"].values
   df["injuriesDirect"]   = dfs["INJURIES_DIRECT"].values
   df["injuriesIndirect"] = dfs["INJURIES_INDIRECT"].values
   df["deathsDirect"]     = dfs["DEATHS_DIRECT"].values
   df["deathsIndirect"]   = dfs["DEATHS_INDIRECT"].values
   
   replDict = {"[kK]": "*1e3", "[mM]": "*1e6", "[bB]": "*1e9", "[hH]": "*1e2", "\?": '', "0\d": '', "^\." : "0."}
   df["damageProperty"] = dfs["DAMAGE_PROPERTY"].replace(replDict, regex=True).values
   df["damageCrops"]    = dfs["DAMAGE_CROPS"].replace(replDict, regex=True).values
   df["damageProperty"] = [eval(val) if val and type(val) == str and not val[0] == "*" else np.nan if (val and type(val) == str and val[0] == "*") or val == '' else val for val in df["damageProperty"]]
   df["damageCrops"]    = [eval(val) if val and type(val) == str and not val[0] == "*" else np.nan if (val and type(val) == str and val[0] == "*") or val == '' else val for val in df["damageCrops"]]
   
   df["source"]         = dfs["SOURCE"].values
   df["overview"]       = dfs["EPISODE_NARRATIVE"].values
   df["details"]        = dfs["EVENT_NARRATIVE"].values
   df["stormEventsEpisodeID"] = dfs["EPISODE_ID"].values
   df["stormEventsReportID"]  = dfs["EVENT_ID"].values
   df["QCd"]       = 0
   df["corrected"] = 0
   df["QCnotes"]     = pd.Series([pd.NA] * len(df), dtype="object")
   df["autoQCnotes"] = pd.Series([pd.NA] * len(df), dtype="object")
   
   for col in ["stormID", "TCname", "stormType", "stormMode", "stormModeReportID", "RMLM", "stormModeSummary"]:
      df[col] = pd.Series([pd.NA] * len(df), dtype="object")
       
   df["stormModeCode"] = np.nan
   df["previousSegment"]   = np.nan
   df["preTornadoTracked"] = np.nan
   df["county"] = dfs["CZ_NAME"].str.title().values
   df["state"]  = dfs["STATE"].str.title().values
   df["CWA"]    = dfs["WFO"].values
   df["NWSRegion"] = np.nan
   df["segmentNumber"] = np.nan

   try:
      dfqc = pd.read_csv("theas_data/1950-2026_Tornado_Reports - Corrected.csv", encoding="utf8", na_values=[-99900,"-99900"], low_memory=False)
      df_qc = df.copy()
      dfqc["magnitude"] = [m if m != "U" else -1 for m in dfqc["magnitude"]]
      if "QCchange" not in dfqc.columns:
         dfqc["QCchange"] = 0

      qc_notes_map = pd.Series(dtype="object")
      if "QCnotes" in dfqc.columns:
         qc_notes_map = (dfqc.dropna(subset=["stormEventsReportID"])
                              .drop_duplicates(subset=["stormEventsReportID"], keep="last")
                              .set_index("stormEventsReportID")["QCnotes"])

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

      if len(dfqc_add) > 0:
         valid_qc_years = {str(y) for y in years}
         add_rows = []
         for _, row in dfqc_add.iterrows():
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
      print(f"Something is wrong with the QC file:\n{err}\nSkipping adding QC info.")

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

   waterspout = [1 if sp == 1 else 0 for sp in df["spout"]]
   landspout  = [1 if event == "Tornado" and (not pd.isnull(details) and ("landspout" in details.lower() or "land spout" in details.lower())) else 0 for event, details in zip(df["severeType"], df["details"])]
   df["type"] = ["Waterspout" if (wspout == 1)
                 else "Landspout" if (lspout == 1)
                 else "Tornado" if (tpe == "Tornado" and mag == "U" and lspout == 0)
                 else "Tornado" if (tpe == "Tornado" and float(mag) < 2)
                 else "Significant Tornado" if (tpe == "Tornado" and float(mag) > 1)
                 else "Unknown"
                 for tpe, mag, lspout, wspout in zip(df["severeType"], df["magnitude"], landspout, waterspout)]

   radlats   = dfr[latName].values
   radlons   = dfr[lonName].values
   radlabels = dfr[radName].values
   begRadDist = [calculateDistVec(beginLat, beginLon, radlats, radlons, radlabels, 500)
                if not pd.isnull(beginLat) else np.nan for beginLat, beginLon in zip(df["beginLatitude"],df["beginLongitude"])]
   endRadDist = [calculateDistVec(endLat, endLon, radlats, radlons, radlabels, 500)
                if not pd.isnull(endLat) else np.nan for endLat, endLon in zip(df["endLatitude"],df["endLongitude"])]

   begRadValid = [np.array(dfr.loc[(dfr["first_date"] <= int(btime[:8])) & (dfr["last_date"] >= int(btime[:8])), "icao"].values) for btime in df["beginTimestamp"]]
   endRadValid = [np.array(dfr.loc[(dfr["first_date"] <= int(etime[:8])) & (dfr["last_date"] >= int(etime[:8])), "icao"].values) for etime in df["endTimestamp"]]
   begRadDist = [radarArray[np.isin(radarArray[:, 1], validRads)] if isinstance(radarArray, np.ndarray) else np.nan
                  for radarArray, validRads in zip(begRadDist, begRadValid)]
   endRadDist = [radarArray[np.isin(radarArray[:, 1], validRads)] if isinstance(radarArray, np.ndarray) else np.nan
                  for radarArray, validRads in zip(endRadDist, endRadValid)]

   isdualpol = np.array([False for _ in begRadDist])
   begRadValid_dp = [np.array(dfr.loc[(dfr["dualpol_date"] <= int(btime[:8])), "icao"].values) for btime in df["beginTimestamp"]]
   endRadValid_dp = [np.array(dfr.loc[(dfr["dualpol_date"] <= int(etime[:8])), "icao"].values) for etime in df["endTimestamp"]]
   begisdualpol = np.array([(begRadarArray.shape[0] > 0 and begRadarArray[0, 1] in begValidRads)
                           if isinstance(begRadarArray, np.ndarray) else False
                           for begRadarArray, begValidRads in zip(begRadDist, begRadValid_dp)])
   endisdualpol = np.array([(endRadarArray.shape[0] > 0 and endRadarArray[0, 1] in endValidRads)
                           if isinstance(endRadarArray, np.ndarray) else False
                           for endRadarArray, endValidRads in zip(endRadDist, endRadValid_dp)])
   isdualpol = np.array([b and e for b, e in zip(begisdualpol, endisdualpol)])

   df["beginRadar"] = [rads[0][1] if isinstance(rads, np.ndarray) and len(rads) > 0 else np.nan for rads in begRadDist]
   df["beginRange"] = [round(rads[0][0], 3) if isinstance(rads, np.ndarray) and len(rads) > 0 else np.nan for rads in begRadDist]
   df["endRadar"]   = [rads[0][1] if isinstance(rads, np.ndarray) and len(rads) > 0 else np.nan for rads in endRadDist]
   df["endRange"]   = [round(rads[0][0], 3) if isinstance(rads, np.ndarray) and len(rads) > 0 else np.nan for rads in endRadDist]
   df["dualpol"]    = [1 if d else 0 for d in isdualpol]

   begRadDisteg = [radarArray[np.isin(radarArray[:, 1], validRads)][0] if not d and isinstance(radarArray, np.ndarray) and len(radarArray) > 0 and any(np.isin(radarArray[:, 1], validRads)) else np.nan
                     for radarArray, validRads, d in zip(begRadDist, begRadValid_dp, isdualpol)]
   endRadDistnd = [radarArray[np.isin(radarArray[:, 1], validRads)][0] if not d and isinstance(radarArray, np.ndarray) and len(radarArray) > 0 and any(np.isin(radarArray[:, 1], validRads)) else np.nan
                     for radarArray, validRads, d in zip(endRadDist, endRadValid_dp, isdualpol)]
   df["dualpolBeginRadar"] = [rads[1] if isinstance(rads, np.ndarray) and len(rads) > 0 and rads[0] <= 300 else np.nan for rads in begRadDisteg]
   df["dualpolBeginRange"] = [round(rads[0], 3) if isinstance(rads, np.ndarray) and len(rads) > 0 and rads[0] <= 300 else np.nan for rads in begRadDisteg]
   df["dualpolEndRadar"]   = [rads[1] if isinstance(rads, np.ndarray) and len(rads) > 0 and rads[0] <= 300 else np.nan for rads in endRadDistnd]
   df["dualpolEndRange"]   = [round(rads[0], 3) if isinstance(rads, np.ndarray) and len(rads) > 0 and rads[0] <= 300 else np.nan for rads in endRadDistnd]
   df["dualpolNotNearest"] =  [1 if not pd.isnull(b) and not pd.isnull(e) else 0 for b, e in zip(df["dualpolBeginRadar"], df["dualpolEndRadar"])]

   for col in ["oneTorID", "multiSegment", "tornadoBeginTime", "tornadoEndTime", "totalDurationMin", "maxMagnitudeAcrossSeg", "totalTornadoLength", "maxTornadoWidth"]:
      df[col] = np.nan
   for col in ["totalInjuriesDirect", "totalInjuriesIndirect", "totalDeathsDirect", "totalDeathsIndirect", "totalDamageProperty", "totalDamageCrops"]:
      df[col] = np.nan
   for col in ["issuedUnix", "issuedTimeDiff"]:
       df[col] = np.nan

   endlats  = df["endLatitude"].values
   endlons  = df["endLongitude"].values
   tor_ids = df["stormEventsReportID"].values
   
   iddists = [calculateDistVec(lat, lon, endlats, endlons, tor_ids, 1) for lat, lon in zip(df["beginLatitude"], df["beginLongitude"])]
   begin_map = df.set_index("stormEventsReportID")["beginUnix"].to_dict()
   end_map = df.set_index("stormEventsReportID")["endUnix"].to_dict()
   county_map = df.set_index("stormEventsReportID")["county"].to_dict()

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
         valid_tie = ((cur_end != end_map.get(prev, np.nan)) or (cur_begin == prev_end and prev < cur))
         valid_county = (prev_county != cur_county)

         if valid_time and valid_tie and valid_county:
            candidate_prev[cur].append((prev, float(d[0]), time_gap))

   for cur in candidate_prev.keys():
      candidate_prev[cur] = sorted(candidate_prev[cur], key=lambda x: (x[2], x[1], x[0]))

   segids = {}
   used_prev = set()
   assign_order = sorted(tor_ids, key=lambda x: (begin_map.get(x, np.inf), x))
   for cur in assign_order:
      for prev, _, _ in candidate_prev.get(cur, []):
         if prev not in used_prev:
            segids[cur] = prev
            used_prev.add(prev)
            break

   df["previousSegment"] = [segids.get(id, np.nan) for id in df["stormEventsReportID"]]

   def _root_and_depth(seg_id):
      depth = 1
      cur = seg_id
      seen = set()
      while cur in segids and cur not in seen:
         seen.add(cur)
         cur = segids[cur]
         depth += 1
      return cur, depth

   roots_depths = [_root_and_depth(seg_id) for seg_id in df["stormEventsReportID"]]
   roots = [rd[0] for rd in roots_depths]
   segnums = [rd[1] for rd in roots_depths]
   chain_sizes = pd.Series(roots).value_counts().to_dict()

   df["oneTorID"] = roots
   df["segmentNumber"] = segnums
   df["multiSegment"] = [1 if chain_sizes.get(root, 0) > 1 else 0 for root in roots]
   starttimes = df.groupby("oneTorID")["beginUnix"].transform(lambda x: x.min() if not x.isnull().all() else np.nan)
   endtimes   = df.groupby("oneTorID")["endUnix"].transform(lambda x: x.max() if not x.isnull().all() else np.nan)
   
   df["tornadoBeginTime"] = df["tornadoBeginTime"].astype(object)
   df["tornadoEndTime"]   = df["tornadoEndTime"].astype(object)
   df["tornadoBeginTime"] = [datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y%m%d-%H%M") for t in starttimes]
   df["tornadoEndTime"]   = [datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y%m%d-%H%M") for t in endtimes]
   df["totalDurationMin"] = (endtimes - starttimes) / 60
   
   df["magnitude"] = [int(x) if str(x) not in ("U", "", "nan") and not pd.isnull(x) else -1 for x in df["magnitude"]]
   df["maxMagnitudeAcrossSeg"] = df.groupby("oneTorID")["magnitude"].transform(lambda x: x.max() if not x.isnull().all() else np.nan)
   df["totalTornadoLength"]    = df.groupby("oneTorID")["tornadoLength"].transform(lambda x: round(x.sum(), 2) if not x.isnull().all() else np.nan)
   df["maxTornadoWidth"] = df.groupby("oneTorID")["tornadoWidth"].transform(lambda x: x.max() if not x.isnull().all() else np.nan)
   
   for col in ["injuriesDirect", "injuriesIndirect", "deathsDirect", "deathsIndirect", "damageProperty", "damageCrops"]:
      try:
         total = df.groupby("oneTorID")[col].transform(lambda x: round(x.sum(), 2) if not x.isnull().all() else np.nan)
         df["total" + col[0].upper() + col[1:]] = total
      except Exception:
         pass

   df["magnitude"] = df["magnitude"].replace(-1, "U")
   df["maxMagnitudeAcrossSeg"] = df["maxMagnitudeAcrossSeg"].replace(-1, "U")
   
   final_cols = ["beginTimestamp","beginYear","beginMonth","beginDay","beginTime","beginUnix","beginTimestampLocal","beginLongitude",
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
            "QCd","corrected","QCnotes","autoQCnotes"]
            
   df = df[[c for c in final_cols if c in df.columns]]
   df.sort_values(by=["beginTimestamp"], inplace=True)
   
   if "oneTorID" in df.columns and "stormEventsReportID" in df.columns:
      df["tempID"] = [id2 if pd.isnull(id1) else id1 for id1, id2 in zip(df["oneTorID"], df["stormEventsReportID"])]
      df["temp"] = [df[df["tempID"] == id]["beginUnix"].values[0] for id in df["tempID"]]
      df.sort_values(by=["temp", "tempID", "segmentNumber"], inplace=True)
      df.drop(labels=["temp", "tempID"],axis=1,inplace=True)
   
   df.to_csv(path_or_buf = "theas_data/1950-2026_tornado_reports.csv", index=False, na_rep=-99900)
   return 0

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
   return dfr, latName, lonName, radName

def calculateDistVec(lat1, lon1, lat2, lon2, labels = [], limit = None):
   R = 6373.0  # Radius of the Earth in kilometers
   rlat1 = np.radians(lat1)
   rlon1 = np.radians(lon1)
   rlat2 = np.radians(lat2)
   rlon2 = np.radians(lon2)
   dlat = rlat2 - rlat1
   dlon = rlon2 - rlon1
   a = np.sin(dlat / 2)**2 + np.cos(rlat1) * np.cos(rlat2) * np.sin(dlon / 2)**2
   c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
   distance = R * c

   if len(labels) > 0:
      labels = np.array(labels, dtype=object)
      pairedResult = np.column_stack((distance, labels))
      if limit:
         pairedResult = pairedResult[pairedResult[:, 0] < limit]
      return pairedResult[pairedResult[:, 0].argsort()]
   return distance

def getTZoffset(timeZone):
   if timeZone[-3:].isdigit() or (timeZone[-3] in ["+", '-'] and timeZone[-2:].isdigit()):
      return int(timeZone[-3:])
   elif timeZone[-2:].isdigit() or (timeZone[-2] in ["+", '-'] and timeZone[-1].isdigit()):
      return int(timeZone[-2:])
   else:
      timezone_offsets = {
      "UTC": 0, "GMT": 0,
      "EST": -5, "EDT": -4,
      "CSC": -6, "SCT": -6,
      "CST": -6, "CDT": -5,
      "MST": -7, "MDT": -6,
      "PST": -8, "PDT": -7,
      "AKST": -9, "AKDT": -8,
      "HST": -10, "SST": -11,
      "CHST": 10, "GST": 10,
      "AST": -4,  "ADT": -3,
      "UNK": 0}
      if timeZone.upper() in timezone_offsets:
         return timezone_offsets[timeZone.upper()]
      else:
         print(f"Could not find timezone {timeZone}. Fix code to handle it. Exiting.")
         exit()

def summarizeRowDifferences(row1, row2, columns, source = ''):
   differences = []
   r1 = isinstance(row1, pd.DataFrame)
   r2 = isinstance(row2, pd.DataFrame)
   for col in columns:
      val1 = row1[col].values if r1 else row1[col]
      val2 = row2[col].values if r2 else row2[col]
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
      result = (source + ": " + "; ".join(differences)) if source else "; ".join(differences)
   else:
      result = np.nan
   return result

if __name__ == "__main__":
   main()