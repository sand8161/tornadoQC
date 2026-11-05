import pandas as pd
import urllib.request
import gzip
import os

# URLs
NCEI_URL = "https://www1.ncdc.noaa.gov/pub/data/swdi/stormevents/csvfiles/StormEvents_details-ftp_v1.0_d2026_c20261105.csv.gz"
SPC_URL = "https://www.spc.noaa.gov/wcm/data/1950-2025_all_tornadoes.csv"

# Output Filenames
NCEI_GZ_FILE = "ncei_temp.csv.gz"
NCEI_OUTPUT = "ncei_storm_details_latest.csv"
SPC_OUTPUT = "1950-2025_all_tornadoes.csv"

def fetch_and_filter_ncei():
    print(f"Downloading NCEI data from {NCEI_URL}...")
    urllib.request.urlretrieve(NCEI_URL, NCEI_GZ_FILE)
    
    print("Loading NCEI data into pandas...")
    with gzip.open(NCEI_GZ_FILE, 'rt', encoding='utf-8', errors='replace') as f:
        df = pd.read_csv(f, low_memory=False)
        
    print(f"Original NCEI row count: {len(df):,}")
    filtered_df = df[df['EVENT_TYPE'].isin(['Tornado', 'Waterspout'])]
    print(f"Filtered row count: {len(filtered_df):,}")
    
    filtered_df.to_csv(NCEI_OUTPUT, index=False)
    print(f"Saved filtered data to {NCEI_OUTPUT}")
    
    if os.path.exists(NCEI_GZ_FILE):
        os.remove(NCEI_GZ_FILE)

def fetch_spc():
    print(f"Downloading SPC data from {SPC_URL}...")
    urllib.request.urlretrieve(SPC_URL, SPC_OUTPUT)
    print(f"Saved SPC data to {SPC_OUTPUT}")

if __name__ == "__main__":
    fetch_and_filter_ncei()
    fetch_spc()