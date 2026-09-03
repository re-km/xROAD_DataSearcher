import html
import tempfile
import unittest
import zipfile
from pathlib import Path

from projects_store import ProjectsStore
from schedule_importer_clean import apply_schedule_to_features, build_schedule_preview, detach_schedule_from_features, parse_workbook


def _cell(ref, value, style=0):
    if value == "":
        return f'<c r="{ref}" s="{style}" />'
    return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t>{html.escape(str(value))}</t></is></c>'


def _workbook_bytes():
    rows = [
        '<row r="1">' + _cell("A1", "", 1) + _cell("B1", "点検車(BT110)") + _cell("E1", "", 2) + _cell("F1", "高所作業車(DT40)") + '</row>',
        '<row r="2">' + _cell("A2", "", 3) + _cell("B2", "点検実施済み") + '</row>',
        '<row r="3">' + _cell("B3", "橋名") + _cell("C3", "9月24日") + _cell("D3", "9月25日") + _cell("E3", "9月26日") + '</row>',
        '<row r="4">' + _cell("A4", "1") + _cell("B4", "落合橋") + _cell("C4", "", 1) + '</row>',
        '<row r="5">' + _cell("A5", "2") + _cell("B5", "土合橋") + _cell("D5", "", 2) + '</row>',
        '<row r="6">' + _cell("A6", "3") + _cell("B6", "新井橋") + _cell("C6", "", 1) + _cell("D6", "", 2) + '</row>',
        '<row r="7">' + _cell("A7", "4") + _cell("B7", "上坂橋") + _cell("E7", "", 3) + '</row>',
    ]
    sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + ''.join(rows) + '</sheetData></worksheet>'
    styles = '''<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fills count="4"><fill><patternFill /></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00" /></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00B050" /></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3366FF" /></patternFill></fill></fills><cellXfs count="4"><xf numFmtId="0" fillId="0" /><xf numFmtId="0" fillId="1" /><xf numFmtId="0" fillId="2" /><xf numFmtId="0" fillId="3" /></cellXfs></styleSheet>'''
    workbook = '''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工程表" sheetId="1" r:id="rId1" /></sheets></workbook>'''
    rels = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" /></Relationships>'''
    output = tempfile.SpooledTemporaryFile()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/styles.xml", styles)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    output.seek(0)
    data = output.read()
    output.close()
    return data


def _feature(name, equipment=None):
    properties = {"shisetsu_id": name, "DPF_title": name}
    if equipment:
        properties["XRDS_equipment"] = equipment
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [139.0, 36.0]}, "properties": properties}


class ScheduleImporterTests(unittest.TestCase):
    def test_real_shape_preview_and_inference(self):
        workbook = _workbook_bytes()
        features = [_feature("落合橋"), _feature("土合橋", "大型橋梁点検車"), _feature("新井橋"), _feature("上坂橋")]
        parsed = parse_workbook(workbook, "2026")
        self.assertEqual(parsed["detected"]["header_row"], 3)
        self.assertEqual(parsed["detected"]["name_column"], "B")
        self.assertEqual(len(parsed["legend"]), 3)
        self.assertEqual(sum(len(row["events"]) for row in parsed["rows"]), 5)

        preview = build_schedule_preview(workbook, "工程表.xlsx", 2026, features)
        self.assertEqual(preview["summary"]["auto_matches"], 4)
        applied = apply_schedule_to_features(features, preview)
        self.assertEqual(features[0]["properties"]["XRDS_equipment"], "橋梁点検車")
        self.assertEqual(features[0]["properties"]["XRDS_equipment_source"], "schedule")
        self.assertEqual(features[1]["properties"]["XRDS_equipment"], "大型橋梁点検車")
        self.assertEqual(features[1]["properties"]["XRDS_equipment_source"], "manual")
        self.assertEqual(features[2]["properties"]["XRDS_schedule_equipment_inference"]["status"], "multiple")
        self.assertNotIn("XRDS_equipment", features[2]["properties"])
        self.assertEqual(features[3]["properties"]["XRDS_inspection_schedule"][0]["status"], "completed")
        self.assertEqual(applied["summary"]["equipment"]["protected_manual"], 1)

        detached = detach_schedule_from_features(features, preview["import_id"])
        self.assertEqual(detached["removed_events"], 5)
        self.assertNotIn("XRDS_inspection_schedule", features[0]["properties"])
        self.assertNotIn("XRDS_equipment", features[0]["properties"])
        self.assertEqual(features[1]["properties"]["XRDS_equipment"], "大型橋梁点検車")

    def test_store_preserves_schedule_metadata_on_normal_save(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProjectsStore(directory)
            feature = _feature("落合橋")
            feature["properties"]["XRDS_print_label_anchor"] = [139.123, 36.456]
            first_revision = store.save("2026年度", "業務", [feature])
            second_revision = store.save("2026年度", "業務", [feature], first_revision, {"schedule_imports": [{"import_id": "x", "status": "active"}]})
            store.save("2026年度", "業務", [feature], second_revision)
            data, _ = store.load("2026年度", "業務")
            self.assertEqual(data["xrds_meta"]["schedule_imports"][0]["import_id"], "x")
            self.assertEqual(data["features"][0]["properties"]["XRDS_print_label_anchor"], [139.123, 36.456])


if __name__ == "__main__":
    unittest.main()
