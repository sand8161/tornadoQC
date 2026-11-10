import pandas as pd
import urllib.request
import gzip
import os
import re
import glob
import json
from html.parser import HTMLParser
# import createReportFile

# URLs
NCEI_DIR_URL = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
SPC_URL = "https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv"

# Output Directories
NCEI_OUT_DIR = "ncei"
SPC_OUTPUT = "spc/1950-2025_all_tornadoes.csv"

class NCEIParser(HTMLParser):
   def __init__(self):
      super().__init__()
      self.files = []
      
   def handle_starttag(self, tag, attrs):
      if tag == 'a':
         for name, value in attrs:
            # Target only the details files
            if name == 'href' and 'StormEvents_details' in value and value.endswith('.csv.gz'):
               self.files.append(value)

def fetch_and_filter_ncei():
   print(f"Fetching NCEI directory listing from {NCEI_DIR_URL}...")
   req = urllib.request.urlopen(NCEI_DIR_URL)
   html = req.read().decode('utf-8')
   
   parser = NCEIParser()
   parser.feed(html)
   
   # Regex to extract the year and creation date (e.g., d2026_c20261105)
   file_pattern = re.compile(r"StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz")
   
   new_data_downloaded = False

   existing_files = [f + ".gz" if not f.endswith(".gz") else f for f in os.listdir(NCEI_OUT_DIR)]
   new_files = [f for f in parser.files if f not in existing_files]

   for filename in new_files:
      match = file_pattern.search(filename)
      if not match:
         continue
         
      year = match.group(1)
      
      # The final unzipped filename we expect to save
      out_filename = filename.replace('.gz', '')
      out_filepath = os.path.join(NCEI_OUT_DIR, out_filename)
         
      print(f"Downloading new data for {year}: {filename}")
      gz_filepath = os.path.join(NCEI_OUT_DIR, filename)
      file_url = NCEI_DIR_URL + filename
      
      urllib.request.urlretrieve(file_url, gz_filepath)
      
      print(f"Filtering {filename}...")
      with gzip.open(gz_filepath, 'rt', encoding='utf-8', errors='replace') as f:
         df = pd.read_csv(f, low_memory=False, dtype=str)
         
      # Filter for Tornado and Waterspout
      filtered_df = df[df['EVENT_TYPE'].isin(['Tornado', 'Waterspout'])]
      filtered_df.to_csv(out_filepath, index=False)
      
      # Clean up the downloaded .gz file
      os.remove(gz_filepath)
      new_data_downloaded = True
      
      # Remove any older versions for this specific year to prevent clutter
      for old_file in os.listdir(NCEI_OUT_DIR):
         if old_file.startswith(f"StormEvents_details-ftp_v1.0_d{year}_c") and old_file != out_filename:
            print(f"Removing outdated file: {old_file}")
            os.remove(os.path.join(NCEI_OUT_DIR, old_file))

   file_map = {}
   for f in os.listdir(NCEI_OUT_DIR):
      if f.endswith('.csv') and 'StormEvents_details-ftp_v1.0_d' in f:
         # Extract the year from the filename
         match = re.search(r'_d(\d{4})_c', f)
         if match:
            file_map[match.group(1)] = f
                
   with open(os.path.join(NCEI_OUT_DIR, 'file_map.json'), 'w') as f:
      json.dump(file_map, f)

   return new_data_downloaded

def combine_ncei_files(new_data_downloaded):
   files = glob.glob(os.path.join(NCEI_OUT_DIR, "StormEvents_details-ftp_*.csv"))
   if not files:
      return

   years = []
   file_pattern = re.compile(r"_d(\d{4})_")
   for f in files:
      match = file_pattern.search(f)
      if match:
         years.append(int(match.group(1)))
         
   if not years:
      return
      
   min_year = min(years)
   max_year = max(years)
   combined_filename = os.path.join(NCEI_OUT_DIR, f"{min_year}-{max_year}_ncei_tornadoes.csv")
   
   # Only combine if new files were downloaded or the target master file is completely missing
   if new_data_downloaded or not os.path.exists(combined_filename):
      print(f"\nCombining {len(files)} NCEI files into {combined_filename}...")
      
      dfs = [pd.read_csv(f, dtype=str, low_memory=False) for f in files]
      combined_df = pd.concat(dfs, ignore_index=True)
      combined_df.to_csv(combined_filename, index=False)
      
      print(f"Successfully saved {combined_filename}.")
      
      # Clean up older combined files (e.g. if the max year rolls over)
      for old_file in glob.glob(os.path.join(NCEI_OUT_DIR, "*_ncei_tornadoes.csv")):
         if old_file != combined_filename:
            os.remove(old_file)

def fetch_spc():
   print("Downloading SPC data...")
   try:
      # Download new file to a temporary location
      temp_output = SPC_OUTPUT + ".tmp"
      urllib.request.urlretrieve(SPC_URL, temp_output)
      
      # Check if we already had a version and if it changed
      if os.path.exists(SPC_OUTPUT):
         with open(SPC_OUTPUT, 'rb') as f1, open(temp_output, 'rb') as f2:
            if f1.read() == f2.read():
               print("SPC file is already up to date.")
               os.remove(temp_output)
               return False
               
      # If it's new or changed, replace the old one
      os.replace(temp_output, SPC_OUTPUT)
      print(f"Saved updated SPC data to {SPC_OUTPUT}")
      return True
      
   except Exception as e:
      print(f"Failed to fetch SPC data: {e}")
      return False

if __name__ == "__main__":
   ncei_updated = fetch_and_filter_ncei()
   spc_updated = fetch_spc()

   # Execute combination logic
   combine_ncei_files(ncei_updated)

   # # If any new data was grabbed, rebuild the final formatted CSV
   # if ncei_updated or spc_updated:
   #    print("\nNew data was downloaded! Running report builder...")
   #    createReportFile.main()
   #    print("\nReport rebuild complete.")
   # else:
   #    print("\nNo new data found. Skipping report rebuild.")