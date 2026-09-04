import io
import json
import sys
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))

import server


class _FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self._payload


class _SearchHarness:
    def __init__(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.headers = {"Content-Length": str(len(body))}
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.status = None

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        pass

    def end_headers(self):
        pass


class SearchApiTests(unittest.TestCase):
    def test_file_search_retries_halfwidth_name_when_wide_query_does_not_match(self):
        requested_names = []
        item = {
            "shisetsu_id": "bridge-1",
            "syogen": {
                "shisetsu": {"meisyou": "A-1"},
                "ichi": {"ido": 35.0, "keido": 135.0},
            },
        }

        def fake_urlopen(request):
            name = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)["name"][0]
            requested_names.append(name)
            if name == "A-1":
                return _FakeResponse({"result": [item]})
            return _FakeResponse({"result": []})

        harness = _SearchHarness({
            "bridge_names": ["A-1"],
            "endpoints": ["bridges"],
            "pref_code": "",
        })

        with patch.object(server.urllib.request, "urlopen", side_effect=fake_urlopen):
            server.RequestHandler.handle_search_api(harness)

        response = json.loads(harness.wfile.getvalue().decode("utf-8"))
        self.assertEqual(harness.status, 200)
        self.assertEqual(response["results"]["A-1"][0]["facility_id"], "bridge-1")
        self.assertEqual(requested_names, ["A-1", "Ａ－１"])


if __name__ == "__main__":
    unittest.main()
