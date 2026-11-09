import gzip
import os
import tempfile
import unittest
from unittest.mock import patch

import update_data


class FetchAndFilterNceiTests(unittest.TestCase):
   def test_download_url_has_separator_when_base_url_lacks_trailing_slash(self):
      filename = "StormEvents_details-ftp_v1.0_d2012_c20261026.csv.gz"
      html = f'<a href="{filename}">download</a>'.encode()
      csv_data = b"EVENT_TYPE,BEGIN_DATE_TIME\nTornado,2026-01-01\n"

      with tempfile.TemporaryDirectory() as output_dir:
         def download(url, destination):
            with gzip.open(destination, "wb") as archive:
               archive.write(csv_data)

         with (
            patch.object(update_data, "NCEI_DIR_URL", "https://example.com/stormevents/csvfiles"),
            patch.object(update_data, "NCEI_OUT_DIR", output_dir),
            patch.object(update_data.urllib.request, "urlopen") as urlopen,
            patch.object(update_data.urllib.request, "urlretrieve", side_effect=download) as urlretrieve,
         ):
            urlopen.return_value.read.return_value = html

            self.assertTrue(update_data.fetch_and_filter_ncei())

         urlretrieve.assert_called_once_with(
            f"https://example.com/stormevents/csvfiles/{filename}",
            os.path.join(output_dir, filename),
         )
         self.assertTrue(os.path.exists(
            os.path.join(output_dir, filename.removesuffix(".gz"))
         ))


if __name__ == "__main__":
   unittest.main()
