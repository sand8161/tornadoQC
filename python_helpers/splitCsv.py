#############################################################################
#
# Split a single CSV file into multiple CSV files while preserving the header.
#
# Example command: python splitCsv.py /path/to/input.csv /path/to/output_dir 10
#
# Author:    Thea Sandmael - 20261022
# Last edit: Thea Sandmael - 20261022
#
#############################################################################

import argparse
import os
import sys

import pandas as pd


def split_csv(input_path, output_dir, num_parts):
   if num_parts <= 0:
      raise ValueError("num_parts must be greater than 0.")

   if not os.path.exists(input_path):
      raise FileNotFoundError("Input CSV not found: {}".format(input_path))

   os.makedirs(output_dir, exist_ok=True)

   df = pd.read_csv(input_path)

   if df.empty:
      print("Input CSV is empty. No rows to split.")
      return

   base_name = os.path.splitext(os.path.basename(input_path))[0]
   total_rows = len(df)
   chunk_size = total_rows // num_parts
   remainder = total_rows % num_parts

   start = 0
   for part in range(1, num_parts + 1):
      extra_row = 1 if part <= remainder else 0
      end = start + chunk_size + extra_row
      chunk = df.iloc[start:end]

      out_path = os.path.join(output_dir, "{}_part{}.csv".format(base_name, part))
      chunk.to_csv(out_path, index=False)
      print("Saved output to: " + out_path)

      start = end


def main(input_path, output_dir, num_parts):
   print("Reading in CSV:")
   print(input_path)

   print("Number of output files:")
   print(num_parts)

   split_csv(input_path, output_dir, num_parts)


if __name__ == "__main__":
   parser = argparse.ArgumentParser(description="Split a CSV file into multiple files while preserving the header.")
   parser.add_argument("input_path", help="Path to the input CSV file.")
   parser.add_argument("output_dir", help="Directory where split CSV files will be written.")
   parser.add_argument("num_parts", type=int, help="Number of output CSV files to create.")
   args = parser.parse_args()

   try:
      main(args.input_path, args.output_dir, args.num_parts)
   except Exception as err:
      print("Error: {}".format(err))
      sys.exit(1)