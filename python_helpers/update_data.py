import pandas as pd
import urllib.request
import gzip
import os
import re
from html.parser import HTMLParser
import createReportFile

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
   print(f"Existing files in {NCEI_OUT_DIR}: {existing_files}")
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
         df = pd.read_csv(f, low_memory=False)
         
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

   return new_data_downloaded

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

   # If any new data was grabbed, rebuild the final formatted CSV
   if ncei_updated:
      print("\nNew data was downloaded! Running report builder...")
      createReportFile.main()
      print("\nReport rebuild complete.")
   else:
      print("\nNo new data found. Skipping report rebuild.")