import base64
import json
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import server
from projects_store import ProjectsStore
from test_schedule_importer import _feature, _workbook_bytes


class ScheduleApiTests(unittest.TestCase):
    def test_preview_apply_status_and_detach(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProjectsStore(directory)
            feature = _feature("落合橋")
            revision = store.save("2026年度", "工程表テスト", [feature])
            original_get_store = server.get_projects_store
            original_load_settings = server.load_settings
            server.get_projects_store = lambda: store
            server.load_settings = lambda: {"auth": ""}
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.RequestHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{httpd.server_address[1]}"
                workbook = base64.b64encode(_workbook_bytes()).decode("ascii")
                payload = {"nendo": "2026年度", "gyomu": "工程表テスト", "schedule_year": "2026", "source_name": "test.xlsx", "workbook_base64": workbook}
                preview = self._post_json(base_url + "/api/schedules/preview", payload)
                self.assertEqual(preview["project_revision"], revision)
                payload.update({"import_id": preview["import_id"], "base_revision": revision, "apply_equipment": True})
                applied = self._post_json(base_url + "/api/schedules/apply", payload)
                self.assertEqual(applied["features"][0]["properties"]["XRDS_equipment"], "橋梁点検車")
                status = self._get_json(base_url + "/api/schedules/status?" + urllib.parse.urlencode({"nendo": "2026年度", "gyomu": "工程表テスト"}))
                self.assertEqual(status["active_import_id"], preview["import_id"])
                detached = self._post_json(base_url + "/api/schedules/detach", {"nendo": "2026年度", "gyomu": "工程表テスト", "import_id": preview["import_id"], "base_revision": applied["revision"]})
                self.assertGreater(detached["removed_events"], 0)
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=2)
                server.get_projects_store = original_get_store
                server.load_settings = original_load_settings

    @staticmethod
    def _post_json(url, payload):
        request = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    @staticmethod
    def _get_json(url):
        with urllib.request.urlopen(url, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
