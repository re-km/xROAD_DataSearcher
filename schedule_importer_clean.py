"""Safe XLSX schedule import, matching, equipment inference, and detach helpers."""

from __future__ import annotations

import base64
import difflib
import hashlib
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta
from io import BytesIO


CELL_REF_RE = re.compile(r"^([A-Za-z]+)(\d+)$")
DATE_RE = re.compile(
    r"(?:(?P<year>\d{4})\s*[\u5e74/\-.])?\s*"
    r"(?P<month>\d{1,2})\s*(?:[\u6708/]|-|\.)(?P<day>\d{1,2})\s*[\u65e5]?"
)
SHEET_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SCHEDULE_YEAR_RE = re.compile(r"^(?:20|19)\d{2}$")

CATEGORY_HINTS = (
    "\u5730\u4e0a", "\u30ea\u30d5\u30c8\u8eca", "\u70b9\u691c\u8eca", "\u9ad8\u6240\u4f5c\u696d\u8eca",
    "\u65b0\u6280\u8853", "\u30dc\u30fc\u30c8", "\u4e88\u5099", "\u6e96\u5099", "\u5b9f\u65bd\u6e08", "\u672a\u5b9f\u65bd",
    "\u78ba\u8a8d\u4e2d",
)
NAME_HEADER_HINTS = ("\u6a4b", "\u6a4b\u6881", "\u65bd\u8a2d", "\u540d\u79f0", "bridge", "name")
ID_HEADER_HINTS = ("shisetsu_id", "\u65bd\u8a2did", "\u65bd\u8a2did", "xroadid", "id")


def validate_schedule_year(value):
    text = str(value or "").strip().replace("\u5e74\u5ea6", "")
    if not SCHEDULE_YEAR_RE.match(text):
        raise ValueError("\u5de5\u7a0b\u8868\u306e\u5e74\u306f\u897f\u66a64\u6841\u3067\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044")
    return int(text)


def normalize_bridge_name(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[\u3000\-\u2010\u2011\u2012\u2013\u2014\u2015,，、・/／()（）\[\]【】「」『』]", "", text)
    return text


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _children(node, name):
    return [child for child in list(node) if _local_name(child.tag) == name]


def _first(node, name):
    for child in list(node):
        if _local_name(child.tag) == name:
            return child
    return None


def _column_number(ref):
    match = CELL_REF_RE.match(str(ref or ""))
    if not match:
        return 0
    number = 0
    for char in match.group(1).upper():
        number = number * 26 + ord(char) - ord("A") + 1
    return number


def _column_name(number):
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result or "A"


def _cell_ref(row, column):
    return f"{_column_name(column)}{row}"


def _color_token(color):
    if color is None:
        return None
    attrs = tuple(sorted((key, value) for key, value in color.attrib.items() if value not in (None, "")))
    return attrs or None


def _fill_display(fill):
    if not fill:
        return None
    return {"pattern": fill[0], "foreground": dict(fill[1] or ()), "background": dict(fill[2] or ())}


class _StyleTable:
    def __init__(self, xml_bytes):
        self.style_fill = {}
        self.date_styles = set()
        self._parse(xml_bytes)

    def _parse(self, xml_bytes):
        root = ET.fromstring(xml_bytes)
        fills = []
        fills_node = next((node for node in root.iter() if _local_name(node.tag) == "fills"), None)
        if fills_node is not None:
            for fill in _children(fills_node, "fill"):
                pattern = _first(fill, "patternFill")
                if pattern is None:
                    fills.append(None)
                    continue
                fg = _color_token(_first(pattern, "fgColor"))
                bg = _color_token(_first(pattern, "bgColor"))
                pattern_type = pattern.attrib.get("patternType", "")
                fills.append((pattern_type, fg, bg) if pattern_type and (fg or bg) else None)

        num_fmts = {}
        num_fmts_node = next((node for node in root.iter() if _local_name(node.tag) == "numFmts"), None)
        if num_fmts_node is not None:
            for item in _children(num_fmts_node, "numFmt"):
                try:
                    num_fmts[int(item.attrib.get("numFmtId", "-1"))] = item.attrib.get("formatCode", "")
                except ValueError:
                    pass

        cell_xfs = next((node for node in root.iter() if _local_name(node.tag) == "cellXfs"), None)
        if cell_xfs is None:
            return
        builtin_dates = set(range(14, 23)) | {45, 46, 47}
        for index, xf in enumerate(_children(cell_xfs, "xf")):
            try:
                fill_id = int(xf.attrib.get("fillId", "0"))
            except ValueError:
                fill_id = 0
            self.style_fill[index] = fills[fill_id] if 0 <= fill_id < len(fills) else None
            try:
                num_fmt_id = int(xf.attrib.get("numFmtId", "0"))
            except ValueError:
                num_fmt_id = 0
            format_code = num_fmts.get(num_fmt_id, "")
            if num_fmt_id in builtin_dates or re.search(r"[dy].*[dy]", format_code.lower()):
                self.date_styles.add(index)

    def fill_key(self, style_id):
        return self.style_fill.get(style_id)

    def is_date_style(self, style_id):
        return style_id in self.date_styles


class _Sheet:
    def __init__(self, name, xml_bytes, shared_strings, styles):
        self.name = name
        self.rows = {}
        self.merged_lookup = {}
        self.styles = styles
        self._parse(xml_bytes, shared_strings)

    def _parse(self, xml_bytes, shared_strings):
        root = ET.fromstring(xml_bytes)
        for merge in [node for node in root.iter() if _local_name(node.tag) == "mergeCell"]:
            ref = merge.attrib.get("ref", "")
            start, _, end = ref.partition(":")
            start_match = CELL_REF_RE.match(start)
            end_match = CELL_REF_RE.match(end or start)
            if not start_match or not end_match:
                continue
            start_row, end_row = int(start_match.group(2)), int(end_match.group(2))
            start_col, end_col = _column_number(start), _column_number(end)
            top_left = (start_row, start_col)
            for row in range(start_row, end_row + 1):
                for col in range(start_col, end_col + 1):
                    self.merged_lookup[(row, col)] = top_left

        for row_node in [node for node in root.iter() if _local_name(node.tag) == "row"]:
            try:
                row_number = int(row_node.attrib.get("r", "0"))
            except ValueError:
                continue
            row = self.rows.setdefault(row_number, {})
            for cell in _children(row_node, "c"):
                ref = cell.attrib.get("r", "")
                col = _column_number(ref)
                if not col:
                    continue
                try:
                    style_id = int(cell.attrib.get("s", "0"))
                except ValueError:
                    style_id = 0
                cell_type = cell.attrib.get("t", "")
                value_node = _first(cell, "v")
                if cell_type == "inlineStr":
                    inline = _first(cell, "is")
                    value = "".join((node.text or "") for node in inline.iter() if _local_name(node.tag) == "t") if inline is not None else ""
                elif value_node is None:
                    value = ""
                else:
                    value = value_node.text or ""
                    if cell_type == "s":
                        try:
                            value = shared_strings[int(value)]
                        except (ValueError, IndexError):
                            value = ""
                    elif cell_type == "b":
                        value = value == "1"
                    elif cell_type not in ("str", "e"):
                        try:
                            value = float(value)
                            if value.is_integer():
                                value = int(value)
                        except ValueError:
                            pass
                row[col] = {"value": value, "style": style_id, "ref": ref or _cell_ref(row_number, col)}

    @property
    def max_row(self):
        return max(self.rows, default=0)

    @property
    def max_col(self):
        return max((max(row, default=0) for row in self.rows.values()), default=0)

    def cell(self, row, col):
        top_left = self.merged_lookup.get((row, col), (row, col))
        return self.rows.get(top_left[0], {}).get(top_left[1], {"value": "", "style": 0, "ref": _cell_ref(*top_left)})


class _Workbook:
    def __init__(self, workbook_bytes):
        self.archive = zipfile.ZipFile(BytesIO(workbook_bytes))
        self.shared_strings = self._read_shared_strings()
        self.styles = _StyleTable(self.archive.read("xl/styles.xml"))
        self.sheet_targets = self._read_sheet_targets()
        self.sheets = {}

    def _read_shared_strings(self):
        try:
            root = ET.fromstring(self.archive.read("xl/sharedStrings.xml"))
        except KeyError:
            return []
        return ["".join((node.text or "") for node in item.iter() if _local_name(node.tag) == "t") for item in root.iter() if _local_name(item.tag) == "si"]

    def _read_sheet_targets(self):
        workbook_root = ET.fromstring(self.archive.read("xl/workbook.xml"))
        rel_root = ET.fromstring(self.archive.read("xl/_rels/workbook.xml.rels"))
        relationships = {item.attrib.get("Id"): item.attrib.get("Target", "") for item in rel_root.iter() if _local_name(item.tag) == "Relationship"}
        targets = {}
        for sheet in [node for node in workbook_root.iter() if _local_name(node.tag) == "sheet"]:
            name = sheet.attrib.get("name", "")
            rel_id = sheet.attrib.get("{" + SHEET_NS + " }id".replace(" ", "")) or sheet.attrib.get("r:id")
            target = relationships.get(rel_id, "")
            if target.startswith("/"):
                target = target.lstrip("/")
            elif not target.startswith("xl/"):
                target = "xl/" + target
            targets[name] = target
        return targets

    def sheet(self, name):
        if name not in self.sheet_targets:
            raise ValueError(f"\u6307\u5b9a\u3055\u308c\u305f\u30b7\u30fc\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: {name}")
        if name not in self.sheets:
            self.sheets[name] = _Sheet(name, self.archive.read(self.sheet_targets[name]), self.shared_strings, self.styles)
        return self.sheets[name]

    def choose_sheet(self, requested=None):
        if requested:
            return self.sheet(requested)
        candidates = []
        for name in self.sheet_targets:
            sheet = self.sheet(name)
            date_count = sum(1 for row in range(1, min(sheet.max_row, 40) + 1) for col in range(1, sheet.max_col + 1) if _parse_date(sheet.cell(row, col)["value"], self.styles.is_date_style(sheet.cell(row, col)["style"]), 2000))
            keyword_score = 5 if re.search(r"\u5de5\u7a0b|\u70b9\u691c|schedule|inspection", name, re.IGNORECASE) else 0
            candidates.append((date_count + keyword_score, name))
        if not candidates:
            raise ValueError("Excel\u306b\u30b7\u30fc\u30c8\u304c\u3042\u308a\u307e\u305b\u3093")
        return self.sheet(max(candidates)[1])


def _parse_date(value, date_style, schedule_year):
    if isinstance(value, (int, float)) and date_style:
        try:
            return (datetime(1899, 12, 30) + timedelta(days=float(value))).strftime("%Y-%m-%d")
        except (OverflowError, ValueError):
            return None
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    if not text:
        return None
    match = DATE_RE.search(text)
    if not match:
        return None
    try:
        year = int(match.group("year") or schedule_year)
        return datetime(year, int(match.group("month")), int(match.group("day"))).strftime("%Y-%m-%d")
    except ValueError:
        return None


def _category_from_text(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    return text if text and any(hint in text for hint in CATEGORY_HINTS) else None


def _status_for_category(category):
    if "\u5b9f\u65bd\u6e08" in category or "\u5b8c\u4e86" in category:
        return "completed"
    if "\u4e88\u5099" in category or "\u6e96\u5099" in category:
        return "reserve"
    if "\u672a\u5b9f\u65bd" in category or "\u78ba\u8a8d\u4e2d" in category:
        return "unknown"
    return "planned"


def _month_from_value(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    match = re.search(r"(?P<month>1[0-2]|[1-9])\s*[\u6708]", text)
    return int(match.group("month")) if match else None


def _detect_headers(sheet, schedule_year):
    best = None
    for row in range(1, sheet.max_row + 1):
        dates = []
        for col in range(1, sheet.max_col + 1):
            cell = sheet.cell(row, col)
            parsed = _parse_date(cell["value"], sheet.styles.is_date_style(cell["style"]), schedule_year)
            if parsed:
                dates.append((col, parsed))
                continue
            value = cell["value"]
            if isinstance(value, (int, float)) and float(value).is_integer() and 1 <= int(value) <= 31:
                month = None
                for prior_row in range(max(1, row - 3), row):
                    month = _month_from_value(sheet.cell(prior_row, col)["value"])
                    if month:
                        break
                if month:
                    try:
                        dates.append((col, datetime(int(schedule_year), month, int(value)).strftime("%Y-%m-%d")))
                    except ValueError:
                        pass
        if len(dates) >= 3:
            score = len(dates) * 10 - row
            if best is None or score > best[0]:
                best = (score, row, dates)
    if best is None:
        raise ValueError("\u65e5\u4ed8\u898b\u51fa\u3057\u3092\u81ea\u52d5\u691c\u51fa\u3067\u304d\u307e\u305b\u3093")
    return best[1], dict(best[2])

def _detect_name_and_id_columns(sheet, header_row, date_columns):
    scores = {}
    id_scores = {}
    for col in range(1, sheet.max_col + 1):
        if col in date_columns:
            continue
        header_values = [unicodedata.normalize("NFKC", str(sheet.cell(row, col)["value"] or "")).strip().lower() for row in range(1, header_row + 1)]
        header_score = sum(20 for value in header_values if any(word in value for word in NAME_HEADER_HINTS))
        id_scores[col] = sum(30 for value in header_values if value in ID_HEADER_HINTS or "shisetsu_id" in value or "\u65bd\u8a2did" in value)
        text_count = 0
        bridge_count = 0
        for row in range(header_row + 1, sheet.max_row + 1):
            value = str(sheet.cell(row, col)["value"] or "").strip()
            if value and not isinstance(sheet.cell(row, col)["value"], (int, float, bool)):
                text_count += 1
                bridge_count += int("\u6a4b" in value)
        scores[col] = text_count + bridge_count * 2 + header_score
    name_col = max(scores, key=scores.get, default=1)
    id_col = max(id_scores, key=id_scores.get, default=0)
    if id_scores.get(id_col, 0) == 0:
        id_col = 0
    return name_col, id_col


def _detect_legend(sheet, header_row):
    category_cells = []
    for row in range(1, header_row + 1):
        for col in range(1, sheet.max_col + 1):
            category = _category_from_text(sheet.cell(row, col)["value"])
            if category:
                category_cells.append((row, col, category))
    mapping = {}
    evidence = {}
    for row, col, category in category_cells:
        candidates = []
        for candidate_row in range(max(1, row - 2), min(header_row, row + 2) + 1):
            for candidate_col in range(max(1, col - 4), min(sheet.max_col, col + 4) + 1):
                cell = sheet.cell(candidate_row, candidate_col)
                fill = sheet.styles.fill_key(cell["style"])
                if not fill:
                    continue
                distance = abs(candidate_row - row) + abs(candidate_col - col)
                if distance == 0 or (distance <= 3 and not str(cell["value"] or "").strip()):
                    candidates.append((distance, cell["ref"], fill))
        if not candidates:
            continue
        nearest = min(item[0] for item in candidates)
        for distance, ref, fill in candidates:
            if distance != nearest:
                continue
            mapping.setdefault(fill, set()).add(category)
            evidence.setdefault(fill, []).append(ref)
    legend = {}
    ambiguous = []
    for fill, categories in mapping.items():
        if len(categories) == 1:
            legend[fill] = next(iter(categories))
        else:
            ambiguous.append({"fill": _fill_display(fill), "categories": sorted(categories), "cells": sorted(set(evidence.get(fill, [])))})
    warnings = []
    if not legend:
        warnings.append("\u51e1\u4f8b\u306e\u8272\u3092\u691c\u51fa\u3067\u304d\u307e\u305b\u3093\u3002\u8272\u4ed8\u304d\u30bb\u30eb\u306f\u672a\u5206\u985e\u306b\u306a\u308a\u307e\u3059")
    if ambiguous:
        warnings.append(f"\u540c\u3058\u8272\u306b\u8907\u6570\u533a\u5206\u304c\u5272\u308a\u5f53\u3066\u3089\u308c\u305f\u51e1\u4f8b\u304c{len(ambiguous)}\u4ef6\u3042\u308a\u307e\u3059")
    return legend, ambiguous, warnings

def parse_workbook(workbook_bytes, schedule_year, sheet_name=None):
    year = validate_schedule_year(schedule_year)
    if not workbook_bytes:
        raise ValueError("空のExcelファイルです")
    try:
        workbook = _Workbook(workbook_bytes)
        sheet = workbook.choose_sheet(sheet_name)
    except (KeyError, ET.ParseError, zipfile.BadZipFile, ValueError) as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError("有効なXLSXファイルを指定してください") from exc
    header_row, date_columns = _detect_headers(sheet, year)
    name_col, id_col = _detect_name_and_id_columns(sheet, header_row, date_columns)
    legend, ambiguous_legend, warnings = _detect_legend(sheet, header_row)
    rows = []
    unknown_fills = set()
    for row_number in range(header_row + 1, sheet.max_row + 1):
        name_cell = sheet.cell(row_number, name_col)
        raw_name = str(name_cell["value"] or "").strip()
        if not raw_name or _category_from_text(raw_name) or raw_name in {"\u540d\u79f0", "\u65bd\u8a2d", "\u6a4b\u6881"}:
            continue
        source_id = str(sheet.cell(row_number, id_col)["value"] or "").strip() if id_col else ""
        events = []
        for col, date in sorted(date_columns.items()):
            cell = sheet.cell(row_number, col)
            fill = sheet.styles.fill_key(cell["style"])
            if not fill:
                continue
            category = legend.get(fill)
            if not category:
                unknown_fills.add(repr(fill))
                continue
            events.append({"date": date, "category": category, "status": _status_for_category(category), "source_cell": cell["ref"]})
        if events or raw_name:
            rows.append({"source_row": row_number, "source_key": f"{sheet.name}!{_column_name(name_col)}{row_number}", "raw_name": raw_name, "normalized_name": normalize_bridge_name(raw_name), "source_id": source_id, "events": events})
    if unknown_fills:
        warnings.append(f"凡例にない色付きセルを{len(unknown_fills)}種類検出しました。該当セルは未分類です")
    return {
        "sheet_name": sheet.name,
        "detected": {"header_row": header_row, "name_column": _column_name(name_col), "id_column": _column_name(id_col) if id_col else None, "date_columns": {_column_name(col): date for col, date in date_columns.items()}, "merged_cells": len(sheet.merged_lookup)},
        "legend": [{"fill": _fill_display(fill), "category": category} for fill, category in legend.items()],
        "ambiguous_legend": ambiguous_legend,
        "warnings": warnings,
        "rows": rows,
    }


def _feature_id(feature, index):
    props = feature.get("properties") or {}
    for key in ("shisetsu_id", "RSDB_shisetsu_id", "DPF_shisetsu_id", "facility_id"):
        value = str(props.get(key, "") or "").strip()
        if value:
            return value
    return f"index:{index}"


def _feature_name(feature):
    props = feature.get("properties") or {}
    for key in ("XRDS_display_name", "DPF_title", "syogen_shisetsu_meisyou", "facility_name"):
        value = str(props.get(key, "") or "").strip()
        if value:
            return value
    return ""


def _match_rows(rows, features, aliases=None):
    aliases = aliases or {}
    feature_items = []
    by_id = {}
    by_name = {}
    for index, feature in enumerate(features):
        item = {"index": index, "id": _feature_id(feature, index), "name": _feature_name(feature), "normalized_name": normalize_bridge_name(_feature_name(feature))}
        feature_items.append(item)
        by_id[item["id"]] = item
        if item["normalized_name"]:
            by_name.setdefault(item["normalized_name"], []).append(item)

    result = []
    for row in rows:
        candidates = []
        method = "unmatched"
        score = 0.0
        if row.get("source_id") and row["source_id"] in by_id:
            candidates = [by_id[row["source_id"]]]
            method, score = "id", 1.0
        else:
            alias_value = aliases.get(row["normalized_name"]) or aliases.get(row["raw_name"])
            if alias_value is not None and str(alias_value) in by_id:
                candidates = [by_id[str(alias_value)]]
                method, score = "manual_alias", 1.0
            if not candidates:
                exact = by_name.get(row["normalized_name"], [])
                if len(exact) == 1:
                    candidates, method, score = exact, "name_exact", 0.95
                elif len(exact) > 1:
                    candidates, method, score = exact, "ambiguous", 0.95
                else:
                    scored = sorted(((difflib.SequenceMatcher(None, row["normalized_name"], item["normalized_name"]).ratio(), item) for item in feature_items if item["normalized_name"]), key=lambda pair: pair[0], reverse=True)
                    if scored:
                        score, best = scored[0]
                        if score >= 0.92 and (len(scored) == 1 or score - scored[1][0] >= 0.08):
                            candidates, method = [best], "name_fuzzy_auto"
                        elif score >= 0.80:
                            candidates, method = [item for _, item in scored[:3]], "name_fuzzy_confirm"
                        else:
                            candidates, method = [], "unmatched"
        status = "auto" if method in {"id", "manual_alias", "name_exact", "name_fuzzy_auto"} and len(candidates) == 1 else "confirm" if candidates else "unmatched"
        result.append({**row, "match": {"status": status, "method": method, "score": round(float(score), 4), "feature_id": candidates[0]["id"] if status == "auto" else None, "feature_index": candidates[0]["index"] if status == "auto" else None, "feature_name": candidates[0]["name"] if len(candidates) == 1 else None, "candidates": [{"feature_id": item["id"], "feature_index": item["index"], "feature_name": item["name"], "score": round(float(score if len(candidates) == 1 else difflib.SequenceMatcher(None, row["normalized_name"], item["normalized_name"]).ratio()), 4)} for item in candidates]}})
    return result


def build_schedule_preview(workbook_bytes, source_name, schedule_year, features, sheet_name=None, aliases=None):
    parsed = parse_workbook(workbook_bytes, schedule_year, sheet_name)
    source_hash = hashlib.sha256(workbook_bytes).hexdigest()
    import_id = f"schedule-{source_hash[:16]}-{validate_schedule_year(schedule_year)}"
    rows = _match_rows(parsed["rows"], features, aliases)
    for row in rows:
        categories = [event.get("category", "") for event in row.get("events", [])]
        mapped = _equipment_candidates(categories)
        if len(mapped) == 1:
            inference = {"status": "auto", "value": mapped[0], "categories": sorted(set(categories))}
        elif len(mapped) > 1:
            inference = {"status": "multiple", "value": None, "categories": sorted(set(categories))}
        else:
            inference = {"status": "none", "value": None, "categories": sorted(set(categories))}
        row["equipment_inference"] = inference
        match = row.get("match", {})
        if match.get("status") == "auto" and match.get("feature_index") is not None:
            props = features[match["feature_index"]].get("properties") or {}
            existing = str(props.get("XRDS_equipment", "") or "").strip()
            row["existing_equipment"] = existing or None
            row["equipment_protected"] = bool(existing and props.get("XRDS_equipment_source") != "schedule")
    summary = {"rows": len(rows), "events": sum(len(row["events"]) for row in rows), "auto_matches": sum(1 for row in rows if row["match"]["status"] == "auto"), "confirm_matches": sum(1 for row in rows if row["match"]["status"] == "confirm"), "unmatched": sum(1 for row in rows if row["match"]["status"] == "unmatched")}
    return {"import_id": import_id, "source": {"file_name": str(source_name or "蟾･遞玖｡ｨ.xlsx"), "sha256": source_hash, "size": len(workbook_bytes), "year": validate_schedule_year(schedule_year)}, "sheet_name": parsed["sheet_name"], "detected": parsed["detected"], "legend": parsed["legend"], "ambiguous_legend": parsed["ambiguous_legend"], "warnings": parsed["warnings"], "rows": rows, "summary": summary}

def _equipment_candidates(categories):
    mapped = set()
    for category in categories:
        if "\u9ad8\u6240\u4f5c\u696d\u8eca" in category:
            mapped.add("\u9ad8\u6240\u4f5c\u696d\u8eca")
        elif "\u70b9\u691c\u8eca" in category:
            mapped.add("\u6a4b\u6881\u70b9\u691c\u8eca")
        elif "\u30ea\u30d5\u30c8\u8eca" in category:
            mapped.add("\u30ea\u30d5\u30c8\u8eca")
        elif "\u30dc\u30fc\u30c8" in category:
            mapped.add("\u30dc\u30fc\u30c8")
    return sorted(mapped)


def _schedule_event_sort_key(event):
    return (event.get("date", "9999-99-99"), event.get("status", ""), event.get("category", ""), event.get("source_cell", ""))


def apply_schedule_to_features(features, preview, decisions=None, apply_equipment=True, replace_import_id=None):
    decisions = decisions or {}
    import_id = preview["import_id"]
    by_id = {_feature_id(feature, index): feature for index, feature in enumerate(features)}
    assignments = {}
    ignored = 0
    for row in preview.get("rows", []):
        match = row.get("match", {})
        target_id = decisions.get(row["source_key"])
        if target_id is None and match.get("status") == "auto":
            target_id = match.get("feature_id")
        if not target_id or str(target_id) not in by_id:
            ignored += 1
            continue
        assignments.setdefault(str(target_id), []).append(row)

    replace_ids = {import_id}
    if replace_import_id:
        replace_ids.add(str(replace_import_id))
    equipment_summary = {"auto": 0, "protected_manual": 0, "multiple": 0}
    for feature in features:
        props = feature.setdefault("properties", {})
        old_events = props.get("XRDS_inspection_schedule") if isinstance(props.get("XRDS_inspection_schedule"), list) else []
        props["XRDS_inspection_schedule"] = [event for event in old_events if event.get("source_import_id") not in replace_ids]
        if props.get("XRDS_equipment_source") == "schedule":
            inference = props.get("XRDS_schedule_equipment_inference") or {}
            if inference.get("source_import_id") in replace_ids:
                props.pop("XRDS_equipment", None)
                props.pop("XRDS_equipment_source", None)
                props.pop("XRDS_schedule_equipment_inference", None)

    for feature_id, rows in assignments.items():
        props = by_id[feature_id].setdefault("properties", {})
        events = props.setdefault("XRDS_inspection_schedule", [])
        categories = []
        for row in rows:
            match = row.get("match", {})
            for event in row.get("events", []):
                categories.append(event.get("category", ""))
                events.append({**event, "source_import_id": import_id, "source_row": row.get("source_row"), "match_method": match.get("method"), "match_score": match.get("score")})
        props["XRDS_inspection_schedule"] = sorted(events, key=_schedule_event_sort_key)
        mapped = _equipment_candidates(categories)
        existing_equipment = str(props.get("XRDS_equipment", "") or "").strip()
        existing_source = props.get("XRDS_equipment_source")
        if existing_equipment and existing_source != "schedule":
            props["XRDS_equipment_source"] = "manual"
            equipment_summary["protected_manual"] += 1
        elif apply_equipment and len(mapped) == 1:
            props["XRDS_equipment"] = mapped[0]
            props["XRDS_equipment_source"] = "schedule"
            props["XRDS_schedule_equipment_inference"] = {"value": mapped[0], "categories": sorted(set(categories)), "source_import_id": import_id, "status": "auto"}
            equipment_summary["auto"] += 1
        elif apply_equipment and len(mapped) > 1:
            props["XRDS_schedule_equipment_inference"] = {"value": None, "categories": sorted(set(categories)), "source_import_id": import_id, "status": "multiple"}
            equipment_summary["multiple"] += 1
    return {"features": features, "summary": {"assigned_rows": sum(len(rows) for rows in assignments.values()), "ignored_rows": ignored, "equipment": equipment_summary}}


def detach_schedule_from_features(features, import_id):
    removed_events = 0
    removed_equipment = 0
    for feature in features:
        props = feature.get("properties") or {}
        events = props.get("XRDS_inspection_schedule")
        if isinstance(events, list):
            kept = [event for event in events if event.get("source_import_id") != import_id]
            removed_events += len(events) - len(kept)
            if kept:
                props["XRDS_inspection_schedule"] = kept
            else:
                props.pop("XRDS_inspection_schedule", None)
        inference = props.get("XRDS_schedule_equipment_inference")
        if props.get("XRDS_equipment_source") == "schedule" and isinstance(inference, dict) and inference.get("source_import_id") == import_id:
            props.pop("XRDS_equipment", None)
            props.pop("XRDS_equipment_source", None)
            props.pop("XRDS_schedule_equipment_inference", None)
            removed_equipment += 1
    return {"features": features, "removed_events": removed_events, "removed_equipment": removed_equipment}


def decode_workbook_base64(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("workbook_base64 is required")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("workbook_base64 is invalid") from exc
    if len(decoded) > 25 * 1024 * 1024:
        raise ValueError("Excel file is too large")
    return decoded
