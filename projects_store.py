"""年度/業務名別のGeoJSON永続化層。標準ライブラリのみで構成する。"""
import os
import hashlib
import json
import math
import re
import tempfile
import threading
import time
import unicodedata

_NENDO_STRICT_RE = re.compile(r'^\d{4}年度$')
_NENDO_DIGITS_RE = re.compile(r'(\d{4})')
_SANITIZE_RE = re.compile(r'[\\/:*?"<>|]')
_CONTROL_RE = re.compile(r'[\x00-\x1f]')
_WINDOWS_RESERVED_NAMES = {
    'CON', 'PRN', 'AUX', 'NUL',
    *(f'COM{i}' for i in range(1, 10)),
    *(f'LPT{i}' for i in range(1, 10)),
}


class ConflictError(Exception):
    """画面で読み込んだ後に保存内容が変わった場合の上書きを検知する例外。"""

    def __init__(self, nendo, gyomu, current_revision):
        self.nendo = nendo
        self.gyomu = gyomu
        self.current_revision = current_revision
        super().__init__(
            f"「{nendo} / {gyomu}」の保存内容が、画面で読み込んだ後に変更されています。"
            "最新内容を確認してください。"
        )


def normalize_nendo(raw):
    """年度表記を「2025年度」形式に正規化する（西暦固定、表記揺れ防止）。"""
    text = (raw or '').strip()
    if _NENDO_STRICT_RE.match(text):
        return text
    m = _NENDO_DIGITS_RE.search(text)
    if m:
        return f"{m.group(1)}年度"
    raise ValueError(f"年度は西暦4桁の「2025年度」形式で指定してください（入力値: {raw!r}）。")


def sanitize_gyomu(raw):
    """業務名をWindowsで安全に扱えるファイル名へ検証する。"""
    name = unicodedata.normalize('NFC', (raw or '').strip())
    if not name:
        raise ValueError("業務名を入力してください。")
    if _SANITIZE_RE.search(name) or _CONTROL_RE.search(name):
        raise ValueError("業務名には \\ / : * ? \" < > | および制御文字は使用できません。")
    if name in {'.', '..'} or name.endswith((' ', '.')):
        raise ValueError("業務名の末尾に空白またはピリオドは使用できません。")
    stem = name.split('.')[0].upper()
    if stem in _WINDOWS_RESERVED_NAMES:
        raise ValueError("業務名にWindows予約語は使用できません。")
    return name


def validate_features(features):
    """地図管理で表示可能なPoint GeoJSON Featureだけを保存対象にする。"""
    if not isinstance(features, list):
        raise ValueError("features は配列で指定してください。")

    for index, feature in enumerate(features, start=1):
        if not isinstance(feature, dict) or feature.get('type') != 'Feature':
            raise ValueError(f"{index}件目のデータがGeoJSON Featureではありません。")
        geometry = feature.get('geometry')
        if not isinstance(geometry, dict) or geometry.get('type') != 'Point':
            raise ValueError(f"{index}件目の位置情報はPoint形式である必要があります。")
        coordinates = geometry.get('coordinates')
        if not isinstance(coordinates, (list, tuple)) or len(coordinates) < 2:
            raise ValueError(f"{index}件目の座標が不足しています。")
        lng, lat = coordinates[0], coordinates[1]
        if (isinstance(lng, bool) or isinstance(lat, bool)
                or not isinstance(lng, (int, float)) or not isinstance(lat, (int, float))
                or not math.isfinite(lng) or not math.isfinite(lat)
                or not -180 <= lng <= 180 or not -90 <= lat <= 90):
            raise ValueError(f"{index}件目の座標が不正です。")
        if not isinstance(feature.get('properties'), dict):
            raise ValueError(f"{index}件目のpropertiesはオブジェクトで指定してください。")


class ProjectsStore:
    """<data_dir>/<年度>/<業務名>.geojson でのファイルベース永続化。"""

    def __init__(self, data_dir):
        self.data_dir = os.path.abspath(data_dir)
        os.makedirs(self.data_dir, exist_ok=True)
        self._lock = threading.Lock()

    def _paths(self, nendo, gyomu):
        nendo = normalize_nendo(nendo)
        gyomu = sanitize_gyomu(gyomu)
        dir_path = os.path.join(self.data_dir, nendo)
        file_path = os.path.join(dir_path, f"{gyomu}.geojson")
        return dir_path, file_path, nendo, gyomu

    def _ensure_data_dir(self):
        """共有フォルダが切断されていればOSErrorで呼び出し元へ通知する。"""
        os.makedirs(self.data_dir, exist_ok=True)
        if not os.path.isdir(self.data_dir):
            raise OSError(f"データ保存先にアクセスできません: {self.data_dir}")

    @staticmethod
    def _revision(file_path):
        digest = hashlib.sha256()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                digest.update(chunk)
        return f"sha256:{digest.hexdigest()}"

    @staticmethod
    def _read_json_with_revision(file_path):
        """同じ読込内容からJSONとrevisionを生成し、共有フォルダの時刻揺れを無視する。"""
        with open(file_path, 'rb') as f:
            raw = f.read()
        return json.loads(raw), f"sha256:{hashlib.sha256(raw).hexdigest()}"

    def list_tree(self):
        """年度→業務名のツリーを、件数・更新日時付きで返す。"""
        tree = []
        self._ensure_data_dir()

        for nendo_name in sorted(os.listdir(self.data_dir)):
            if nendo_name == '_trash':
                continue
            nendo_path = os.path.join(self.data_dir, nendo_name)
            if not os.path.isdir(nendo_path):
                continue

            projects = []
            for fname in sorted(os.listdir(nendo_path)):
                if not fname.lower().endswith('.geojson'):
                    continue
                fpath = os.path.join(nendo_path, fname)
                try:
                    data, revision = self._read_json_with_revision(fpath)
                except (OSError, json.JSONDecodeError):
                    continue

                meta = data.get('xrds_meta', {}) if isinstance(data, dict) else {}
                gyomu = meta.get('gyomu') or fname[:-len('.geojson')]
                count = meta.get('count')
                if count is None:
                    count = len(data.get('features', [])) if isinstance(data, dict) else 0

                projects.append({
                    'gyomu': gyomu,
                    'count': count,
                    'saved_at': meta.get('saved_at', ''),
                    'revision': revision,
                })

            if projects:
                tree.append({'nendo': nendo_name, 'projects': projects})

        return tree

    def load(self, nendo, gyomu):
        _, fpath, nendo, gyomu = self._paths(nendo, gyomu)
        if not os.path.exists(fpath):
            raise FileNotFoundError(f"「{nendo} / {gyomu}」は見つかりません。")
        return self._read_json_with_revision(fpath)

    def save(self, nendo, gyomu, features, base_revision=None, extra_meta=None):
        """Save atomically and preserve metadata that is not owned by this call."""
        dir_path, fpath, nendo, gyomu = self._paths(nendo, gyomu)
        validate_features(features)
        with self._lock:
            existing_meta = {}
            if os.path.exists(fpath):
                current_revision = self._revision(fpath)
                if base_revision is None:
                    raise ConflictError(nendo, gyomu, current_revision)
                requested_revision = str(base_revision)
                if requested_revision != current_revision:
                    raise ConflictError(nendo, gyomu, current_revision)
                try:
                    current_data, _ = self._read_json_with_revision(fpath)
                    if isinstance(current_data, dict) and isinstance(current_data.get('xrds_meta'), dict):
                        existing_meta = dict(current_data['xrds_meta'])
                except (OSError, json.JSONDecodeError):
                    existing_meta = {}

            os.makedirs(dir_path, exist_ok=True)
            meta = {
                **existing_meta,
                'nendo': nendo,
                'gyomu': gyomu,
                'saved_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
                'count': len(features),
            }
            if isinstance(extra_meta, dict):
                meta.update(extra_meta)
            geojson = {
                'type': 'FeatureCollection',
                'xrds_meta': meta,
                'features': features,
            }
            payload = json.dumps(geojson, ensure_ascii=False, indent=2) + '\n'
            self._ensure_data_dir()
            fd, temp_path = tempfile.mkstemp(prefix=f'.{gyomu}.', suffix='.tmp', dir=dir_path)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_path, fpath)
            except Exception:
                try:
                    os.close(fd)
                except OSError:
                    pass
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
                raise
            return self._revision(fpath)
    def delete(self, nendo, gyomu, base_revision=None):
        """一致するrevisionのファイルだけを _trash/ 配下へ移動する。"""
        _, fpath, nendo, gyomu = self._paths(nendo, gyomu)
        trash_dir = os.path.join(self.data_dir, '_trash', nendo)
        with self._lock:
            if not os.path.exists(fpath):
                raise FileNotFoundError(f"「{nendo} / {gyomu}」は見つかりません。")
            current_revision = self._revision(fpath)
            if base_revision is None or str(base_revision) != current_revision:
                raise ConflictError(nendo, gyomu, current_revision)
            os.makedirs(trash_dir, exist_ok=True)
            dest = os.path.join(trash_dir, f"{gyomu}_{time.time_ns()}.geojson")
            os.replace(fpath, dest)