import os
import sys
import json
import time
import re
import base64
import hmac
import urllib.request
import urllib.parse
import unicodedata
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import socket
import threading
import webbrowser
import io
import zipfile
import cgi
from schedule_importer_clean import (apply_schedule_to_features, build_schedule_preview, decode_workbook_base64, detach_schedule_from_features, validate_schedule_year)

from projects_store import ProjectsStore, ConflictError

# API Endpoint
XROAD_API_URL = "https://road-structures-db.mlit.go.jp/xROAD/api/v1/bridges"
MAX_PROJECT_REQUEST_BYTES = 20 * 1024 * 1024
STATIC_ALLOWED_SUFFIXES = {'.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.map'}

_SETTINGS_CACHE = None

def load_settings():
    """appsettings.json を読み込む（初回のみ、以後はキャッシュを返す）"""
    global _SETTINGS_CACHE
    if _SETTINGS_CACHE is not None:
        return _SETTINGS_CACHE
    settings_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "appsettings.json")
    settings = {}
    if os.path.exists(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: appsettings.json の読み込みに失敗しました: {e}")
    _SETTINGS_CACHE = settings
    return settings

def load_api_key():
    """appsettings.json → 環境変数 GEMINI_API_KEY の優先順で API キーを取得"""
    settings = load_settings()
    key = str(settings.get("gemini_api_key", "")).strip()
    if key:
        return key
    return os.environ.get("GEMINI_API_KEY", "")

def resolve_data_dir():
    """appsettings.json の data_dir（社内共有フォルダ想定）。未設定時はプロジェクト内 data/ にフォールバック"""
    settings = load_settings()
    configured = str(settings.get("data_dir", "")).strip()
    if configured:
        return configured
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

_PROJECTS_STORE = None

def get_projects_store():
    global _PROJECTS_STORE
    if _PROJECTS_STORE is None:
        _PROJECTS_STORE = ProjectsStore(resolve_data_dir())
    return _PROJECTS_STORE

# Target QML file
QML_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "style_sample.qml")

_STYLE_RULES_CACHE = None
_STYLE_FALLBACK = {
    "default": {"fill": "rgba(150,150,150,0.8)", "text": "rgba(0,0,0,1)", "border": "rgba(128,128,128,0.86)"}
}

def _parse_qml_color(raw):
    """QMLの'r,g,b,a,rgb:...'形式をCSSのrgba()文字列に変換する(alphaは0-255を0-1に変換)"""
    parts = raw.split(',')
    r, g, b, a = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
    return f"rgba({r},{g},{b},{round(a / 255, 3)})"

def get_style_rules():
    """style_sample.qmlのラベリングルールを限定パースし、判定区分値ごとの配色を返す。
    汎用QGIS式パーサではなく、filter属性の '= <数値>' と shapeFillColor/textColor/shapeBorderColor のみを正規表現抽出する。
    正本はQMLそのものであり、ここに配色をハードコードしない。パース失敗時のみグレー単色にフォールバックする。
    """
    global _STYLE_RULES_CACHE
    if _STYLE_RULES_CACHE is not None:
        return _STYLE_RULES_CACHE

    try:
        with open(QML_FILE_PATH, 'r', encoding='utf-8') as f:
            content = f.read()

        rules = {}
        for filter_attr, block in re.findall(r'<rule filter="([^"]*)"[^>]*>(.*?)</rule>', content, re.DOTALL):
            m = re.search(r'hantei_kubun&quot;\)\s*=\s*(\d+)', filter_attr)
            if m:
                key = m.group(1)
            elif filter_attr.strip() == 'ELSE':
                key = 'other'
            else:
                continue

            fill_m = re.search(r'shapeFillColor="([^"]*)"', block)
            if not fill_m:
                continue
            text_m = re.search(r'textColor="([^"]*)"', block)
            border_m = re.search(r'shapeBorderColor="([^"]*)"', block)

            rules[key] = {
                "fill": _parse_qml_color(fill_m.group(1)),
                "text": _parse_qml_color(text_m.group(1)) if text_m else "rgba(0,0,0,1)",
                "border": _parse_qml_color(border_m.group(1)) if border_m else "rgba(128,128,128,0.86)",
            }

        if not rules:
            print("Warning: style_sample.qml から判定区分の色ルールを抽出できませんでした。既定のグレー配色を使用します。")
            return _STYLE_FALLBACK

        _STYLE_RULES_CACHE = rules
        return rules
    except (OSError, IOError) as e:
        print(f"Warning: style_sample.qml の解析に失敗しました: {e}")
        return _STYLE_FALLBACK

class RequestHandler(SimpleHTTPRequestHandler):
    def _check_auth(self):
        """appsettings.jsonのauthが設定されている場合のみBasic認証を要求する（共有ユーザー名+共有パスワード方式）"""
        settings = load_settings()
        auth_secret = str(settings.get("auth", "")).strip()
        if not auth_secret:
            return True
        auth_user = str(settings.get("auth_user", "")).strip()

        header = self.headers.get('Authorization', '')
        if header.startswith('Basic '):
            try:
                decoded = base64.b64decode(header[6:]).decode('utf-8')
                username, _, password = decoded.partition(':')
                if (hmac.compare_digest(password, auth_secret)
                        and (not auth_user or hmac.compare_digest(username, auth_user))):
                    return True
            except (ValueError, UnicodeDecodeError):
                pass

        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="xROAD Data Searcher"')
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write("認証が必要です。".encode('utf-8'))
        return False

    def _send_storage_error(self, error):
        self.send_response(503)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write(
            f"データ保存先フォルダに接続できません。ネットワーク接続(VPN/社内LAN)を確認してください。詳細: {error}".encode('utf-8')
        )

    def _read_project_json_body(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
        except ValueError as exc:
            raise ValueError("Content-Length が不正です。") from exc
        if content_length < 0 or content_length > MAX_PROJECT_REQUEST_BYTES:
            raise ValueError("保存データが大きすぎます（上限20MB）。")
        try:
            return json.loads(self.rfile.read(content_length).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("JSON形式の保存データを指定してください。") from exc
    def _serve_safe_static(self, request_path):
        """UIに必要な静的ファイルだけを配信し、設定・ソース・保存データをHTTPで公開しない。"""
        if request_path == '/':
            request_path = '/index.html'
        decoded = urllib.parse.unquote(request_path)
        root = os.path.dirname(os.path.abspath(__file__))
        candidate = os.path.abspath(os.path.join(root, decoded.lstrip('/')))
        try:
            inside_root = os.path.commonpath([root, candidate]) == root
        except ValueError:
            inside_root = False
        suffix = os.path.splitext(candidate)[1].lower()
        if not inside_root or suffix not in STATIC_ALLOWED_SUFFIXES or not os.path.isfile(candidate):
            self.send_error(404, "Static file not found")
            return
        self.path = urllib.parse.quote(decoded)
        super().do_GET()

    def do_GET(self):
        if not self._check_auth():
            return

        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/style':
            self.handle_style_api()
        elif parsed.path == '/api/projects':
            self.handle_projects_list_api()
        elif parsed.path == '/api/projects/load':
            self.handle_projects_load_api(parsed.query)
        elif parsed.path == '/api/schedules/status':
            self.handle_schedule_status_api(parsed.query)
        else:
            self._serve_safe_static(parsed.path)
    def do_POST(self):
        if not self._check_auth():
            return

        if self.path == '/api/extract':
            self.handle_extract_api()
        elif self.path == '/api/search':
            self.handle_search_api()
        elif self.path == '/api/condition_search':
            self.handle_condition_search_api()
        elif self.path == '/api/export':
            self.handle_export_api()
        elif self.path == '/api/projects/save':
            self.handle_projects_save_api()
        elif self.path == '/api/projects/delete':
            self.handle_projects_delete_api()
        elif self.path == '/api/schedules/preview':
            self.handle_schedule_preview_api()
        elif self.path == '/api/schedules/apply':
            self.handle_schedule_apply_api()
        elif self.path == '/api/schedules/detach':
            self.handle_schedule_detach_api()
        else:
            self.send_error(404, "Endpoint not found")

    def _send_json(self, status, payload):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))

    def _schedule_request(self):
        request_json = self._read_project_json_body()
        nendo = request_json.get('nendo', '')
        gyomu = request_json.get('gyomu', '')
        year = validate_schedule_year(request_json.get('schedule_year'))
        workbook = decode_workbook_base64(request_json.get('workbook_base64'))
        source_name = request_json.get('source_name') or 'schedule.xlsx'
        return request_json, nendo, gyomu, year, workbook, source_name

    def handle_schedule_preview_api(self):
        store = self._get_store_or_error()
        if store is None:
            return
        try:
            request_json, nendo, gyomu, year, workbook, source_name = self._schedule_request()
            data, revision = store.load(nendo, gyomu)
            preview = build_schedule_preview(workbook, source_name, year, data.get('features', []), request_json.get('sheet_name'), request_json.get('aliases'))
            preview['project_revision'] = revision
            self._send_json(200, preview)
        except FileNotFoundError as exc:
            self._send_json(404, {'error': str(exc)})
        except ValueError as exc:
            self._send_json(400, {'error': str(exc)})
        except OSError as exc:
            self._send_storage_error(exc)
        except Exception as exc:
            self._send_json(500, {'error': str(exc)})

    def handle_schedule_apply_api(self):
        store = self._get_store_or_error()
        if store is None:
            return
        try:
            request_json, nendo, gyomu, year, workbook, source_name = self._schedule_request()
            data, _ = store.load(nendo, gyomu)
            preview = build_schedule_preview(workbook, source_name, year, data.get('features', []), request_json.get('sheet_name'), request_json.get('aliases'))
            requested_import_id = str(request_json.get('import_id') or preview['import_id'])
            if requested_import_id != preview['import_id']:
                raise ValueError('Preview source does not match.')
            meta = data.get('xrds_meta') if isinstance(data.get('xrds_meta'), dict) else {}
            applied = apply_schedule_to_features(data.get('features', []), preview, request_json.get('decisions'), bool(request_json.get('apply_equipment', True)), meta.get('schedule_active_import_id'))
            history = list(meta.get('schedule_imports') or [])
            now = time.strftime('%Y-%m-%dT%H:%M:%S')
            for item in history:
                if isinstance(item, dict) and item.get('status') == 'active':
                    item['status'] = 'replaced'
                    item['replaced_at'] = now
            history.append({
                'import_id': preview['import_id'],
                'status': 'active',
                'source': preview['source'],
                'sheet_name': preview['sheet_name'],
                'detected': preview['detected'],
                'imported_at': now,
                'summary': {**preview['summary'], **applied['summary']},
                'decisions': request_json.get('decisions') or {},
            })
            new_revision = store.save(
                nendo,
                gyomu,
                applied['features'],
                request_json.get('base_revision'),
                {'schedule_imports': history, 'schedule_active_import_id': preview['import_id']},
            )
            self._send_json(200, {'ok': True, 'revision': new_revision, 'features': applied['features'], 'import_id': preview['import_id'], 'summary': {**preview['summary'], **applied['summary']}})
        except ConflictError as exc:
            self._send_json(409, {'error': str(exc), 'current_revision': exc.current_revision})
        except FileNotFoundError as exc:
            self._send_json(404, {'error': str(exc)})
        except ValueError as exc:
            self._send_json(400, {'error': str(exc)})
        except OSError as exc:
            self._send_storage_error(exc)
        except Exception as exc:
            self._send_json(500, {'error': str(exc)})

    def handle_schedule_status_api(self, query_string):
        store = self._get_store_or_error()
        if store is None:
            return
        try:
            params = urllib.parse.parse_qs(query_string)
            nendo = params.get('nendo', [''])[0]
            gyomu = params.get('gyomu', [''])[0]
            data, revision = store.load(nendo, gyomu)
            meta = data.get('xrds_meta') if isinstance(data.get('xrds_meta'), dict) else {}
            self._send_json(200, {'revision': revision, 'active_import_id': meta.get('schedule_active_import_id'), 'imports': meta.get('schedule_imports') or []})
        except FileNotFoundError as exc:
            self._send_json(404, {'error': str(exc)})
        except ValueError as exc:
            self._send_json(400, {'error': str(exc)})
        except OSError as exc:
            self._send_storage_error(exc)
        except Exception as exc:
            self._send_json(500, {'error': str(exc)})

    def handle_schedule_detach_api(self):
        store = self._get_store_or_error()
        if store is None:
            return
        try:
            request_json = self._read_project_json_body()
            nendo = request_json.get('nendo', '')
            gyomu = request_json.get('gyomu', '')
            import_id = str(request_json.get('import_id') or '').strip()
            if not import_id:
                raise ValueError('Schedule import is not specified.')
            data, _ = store.load(nendo, gyomu)
            detached = detach_schedule_from_features(data.get('features', []), import_id)
            meta = data.get('xrds_meta') if isinstance(data.get('xrds_meta'), dict) else {}
            history = list(meta.get('schedule_imports') or [])
            now = time.strftime('%Y-%m-%dT%H:%M:%S')
            for item in history:
                if isinstance(item, dict) and item.get('import_id') == import_id and item.get('status') == 'active':
                    item['status'] = 'detached'
                    item['detached_at'] = now
            active = meta.get('schedule_active_import_id')
            new_revision = store.save(
                nendo,
                gyomu,
                detached['features'],
                request_json.get('base_revision'),
                {'schedule_imports': history, 'schedule_active_import_id': None if active == import_id else active},
            )
            self._send_json(200, {'ok': True, 'revision': new_revision, **detached})
        except ConflictError as exc:
            self._send_json(409, {'error': str(exc), 'current_revision': exc.current_revision})
        except FileNotFoundError as exc:
            self._send_json(404, {'error': str(exc)})
        except ValueError as exc:
            self._send_json(400, {'error': str(exc)})
        except OSError as exc:
            self._send_storage_error(exc)
        except Exception as exc:
            self._send_json(500, {'error': str(exc)})
    def handle_style_api(self):
        rules = get_style_rules()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(rules, ensure_ascii=False).encode('utf-8'))

    def _get_store_or_error(self):
        """データ保存先に接続できない場合、503を返してNoneを返す。"""
        try:
            return get_projects_store()
        except OSError as e:
            self._send_storage_error(e)
            return None
    def handle_projects_list_api(self):
        store = self._get_store_or_error()
        if store is None:
            return
        try:
            tree = store.list_tree()
        except OSError as e:
            self._send_storage_error(e)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"tree": tree}, ensure_ascii=False).encode('utf-8'))
    def handle_projects_load_api(self, query_string):
        params = urllib.parse.parse_qs(query_string)
        nendo = params.get('nendo', [''])[0]
        gyomu = params.get('gyomu', [''])[0]
        store = self._get_store_or_error()
        if store is None:
            return
        try:
            data, revision = store.load(nendo, gyomu)
            data.setdefault('xrds_meta', {})['revision'] = revision
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        except FileNotFoundError as e:
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))
        except ValueError as e:
            self.send_response(400)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))
        except OSError as e:
            self._send_storage_error(e)
    def handle_projects_save_api(self):
        store = self._get_store_or_error()
        if store is None:
            return
        try:
            request_json = self._read_project_json_body()
            nendo = request_json.get('nendo', '')
            gyomu = request_json.get('gyomu', '')
            features = request_json.get('features', [])
            base_revision = request_json.get('base_revision')
            revision = store.save(nendo, gyomu, features, base_revision)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "revision": revision}, ensure_ascii=False).encode('utf-8'))
        except ConflictError as ce:
            self.send_response(409)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(
                {"error": str(ce), "current_revision": ce.current_revision}, ensure_ascii=False
            ).encode('utf-8'))
        except ValueError as ve:
            self.send_response(400)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(str(ve).encode('utf-8'))
        except OSError as e:
            self._send_storage_error(e)
        except Exception as e:
            self.send_error(500, f"Server Error: {str(e)}")
    def handle_projects_delete_api(self):
        store = self._get_store_or_error()
        if store is None:
            return
        try:
            request_json = self._read_project_json_body()
            nendo = request_json.get('nendo', '')
            gyomu = request_json.get('gyomu', '')
            base_revision = request_json.get('base_revision')
            store.delete(nendo, gyomu, base_revision)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}, ensure_ascii=False).encode('utf-8'))
        except ConflictError as ce:
            self.send_response(409)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(
                {"error": str(ce), "current_revision": ce.current_revision}, ensure_ascii=False
            ).encode('utf-8'))
        except FileNotFoundError as e:
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))
        except ValueError as e:
            self.send_response(400)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))
        except OSError as e:
            self._send_storage_error(e)
        except Exception as e:
            self.send_error(500, f"Server Error: {str(e)}")
    @staticmethod
    def flatten_dict(d, parent_key='', sep='_'):
        items = []
        for k, v in d.items():
            new_key = f"{parent_key}{sep}{k}" if parent_key else k
            if isinstance(v, dict):
                items.extend(RequestHandler.flatten_dict(v, new_key, sep=sep).items())
            else:
                items.append((new_key, v))
        return dict(items)

    def extract_text_from_pdf(self, file_data):
        try:
            import fitz  # PyMuPDF
        except ImportError as exc:
            raise ValueError(
                "PDFの読み込みに必要なPyMuPDFが見つかりません。"
                "python -m pip install -r requirements.txt を実行してください。"
            ) from exc

        try:
            with fitz.open(stream=file_data, filetype="pdf") as doc:
                return "".join(page.get_text() for page in doc)
        except Exception as exc:
            raise ValueError(f"PDFを開けませんでした: {exc}") from exc

    @staticmethod
    def create_gemini_client(api_key):
        """Load the Gemini SDK only when AI extraction is requested."""
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:
            raise ValueError(
                "AI抽出に必要なgoogle-genaiが見つかりません。"
                "python -m pip install -r requirements.txt を実行してください。"
            ) from exc
        return genai.Client(api_key=api_key), types

    def handle_extract_api(self):
        try:
            # Parse multipart/form-data
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={'REQUEST_METHOD': 'POST',
                         'CONTENT_TYPE': self.headers['Content-Type'],
                         }
            )
            
            if 'file' not in form:
                raise ValueError("読み込むファイルが指定されていません。")
            file_item = form['file']
            file_name = file_item.filename
            file_data = file_item.file.read()
            facility_type_jp = form.getvalue('facility_type_jp', '施設')
            
            raw_text = ""
            if file_name.lower().endswith('.pdf'):
                raw_text = self.extract_text_from_pdf(file_data)
            else:
                # If it's a CSV or text sent by the frontend, try decoding it
                try:
                    raw_text = file_data.decode('utf-8')
                except:
                    try:
                        raw_text = file_data.decode('shift_jis')
                    except:
                        raw_text = str(file_data) # Fallback to bytes string
            
            if not raw_text.strip():
                raise ValueError("ファイルからテキストを抽出できませんでした。")

            # Check if API Key is set
            api_key = load_api_key()
            if not api_key:
                raise ValueError("Gemini APIキーが設定されていません。appsettings.json に gemini_api_key を設定するか、環境変数 GEMINI_API_KEY を設定してください。")

            # Call Gemini
            client, genai_types = self.create_gemini_client(api_key)
            prompt = f"""
以下のテキストデータから、「{facility_type_jp}」の名前と推測される文字列をすべて抽出し、JSONの配列形式で出力してください。
例えば、「158-上半原-003」のような記号と数字の組み合わせや、橋の名前とは一見思えない数字だけの羅列であっても、文脈上施設名であれば抽出してください。
余計な説明文やマークダウンは一切含めず、純粋なJSON配列のみを返してください。

抽出対象のテキスト:
'''
{raw_text[:20000]}
'''

出力形式の例:
["施設名1", "158-上半原-003", "施設名3"]
"""
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
                config=genai_types.GenerateContentConfig(
                    temperature=0.0
                )
            )
            
            response_text = response.text.strip()
            if response_text.startswith("```json"):
                response_text = response_text[7:-3].strip()
            elif response_text.startswith("```"):
                response_text = response_text[3:-3].strip()
                
            extracted_names = json.loads(response_text)
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            self.wfile.write(json.dumps({"names": extracted_names}, ensure_ascii=False).encode('utf-8'))
            
        except ValueError as ve:
            self.send_response(400)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(str(ve).encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(f"Error extracting text: {str(e)}".encode('utf-8'))

    def handle_search_api(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            request_json = json.loads(post_data)
            
            bridge_names = request_json.get("bridge_names", [])
            endpoints = request_json.get("endpoints", ["bridges"])
            pref_code = request_json.get("pref_code", "")
            city_filter = unicodedata.normalize(
                'NFKC', str(request_json.get("city", "") or "")
            ).replace(' ', '').replace('　', '').casefold()
            
            # 検索結果を格納する辞書
            # キー: ユーザーが入力した検索名
            # 値: 候補となる施設のリスト
            search_results = {}
            
            for name in bridge_names:
                search_results[name] = []
                
                # Normalize the name for search (NFKC converts fullwidth alphabet/numbers to halfwidth)
                normalized_name = unicodedata.normalize('NFKC', name)
                
                # Remove any spaces (halfwidth and fullwidth) since xROAD API is strict
                normalized_name = normalized_name.replace(' ', '').replace('　', '')
                
                # Create query variations (some xROAD DB entries use fullwidth numbers, some use halfwidth)
                query_variations = [normalized_name]
                wide_name = ''
                for char in normalized_name:
                    code = ord(char)
                    if 0x21 <= code <= 0x7E:
                        wide_name += chr(code + 0xFEE0)
                    else:
                        wide_name += char
                if wide_name != normalized_name:
                    query_variations.append(wide_name)
                
                # Remove empty endpoints fallback -> we use whatever the user selected
                for ep in endpoints:
                    for q_name in query_variations:
                        # API Query with proper parameters using name variations
                        params = {'name': q_name, 'limit': 100}
                        if pref_code:
                            params['pref'] = pref_code
                            
                        query = urllib.parse.urlencode(params)
                        url = f"https://road-structures-db.mlit.go.jp/xROAD/api/v1/{ep}?{query}"
                        
                        req = urllib.request.Request(url)
                    try:
                        with urllib.request.urlopen(req) as res:
                            body = res.read()
                            data = json.loads(body.decode('utf-8'))
                            
                            results = data.get('result', [])
                            for item in results:
                                syogen = item.get('syogen', {})
                                tenken = item.get('tenken', {})
                                
                                ido = syogen.get('ichi', {}).get('ido')
                                keido = syogen.get('ichi', {}).get('keido')
                                
                                if ido is not None and keido is not None:
                                    facility_name = syogen.get("shisetsu", {}).get("meisyou", "不明")
                                    ichi_data = syogen.get("ichi", {})
                                    gyousei_data = syogen.get("gyousei_kuiki", {})
                                    facility_pref = (
                                        gyousei_data.get("todoufuken_mei")
                                        or ichi_data.get("todofuken_meisyou", "不明")
                                    )
                                    facility_city = (
                                        gyousei_data.get("shikuchouson_mei")
                                        or ichi_data.get("shikutyouson_meisyou", "")
                                    )
                                    normalized_city = unicodedata.normalize(
                                        'NFKC', str(facility_city or "")
                                    ).replace(' ', '').replace('　', '').casefold()
                                    if city_filter and city_filter not in normalized_city:
                                        continue
                                    location_str = f"{facility_pref}{facility_city}"
                                    
                                    kanrisya_name = syogen.get("kanrisya", {}).get("meisyou", "")
                                    rosen_name = syogen.get("rosen", {}).get("meisyou", "")
                                    
                                    # Feature construction format
                                    properties = {
                                        "DPF_title": facility_name,
                                        "RSDB_tenken_kiroku_hantei_kubun": tenken.get("kiroku", {}).get("hantei_kubun", ""),
                                        "kasetsu_nendo": syogen.get("kasetsu_nendo", ""),
                                        "fukuin": syogen.get("fukuin", ""),
                                        "kyouchou": syogen.get("kyouchou", "")
                                    }
                                    
                                    # Flatten all other attributes into properties so they appear in QGIS
                                    flat_item = RequestHandler.flatten_dict(item)
                                    for k, v in flat_item.items():
                                        if k not in properties:
                                            properties[k] = v

                                    feature = {
                                        "type": "Feature",
                                        "geometry": {
                                            "type": "Point",
                                            "coordinates": [keido, ido]
                                        },
                                        "properties": properties
                                    }
                                    
                                    candidate = {
                                        "facility_id": item.get("shisetsu_id", ""),
                                        "facility_type": ep,
                                        "facility_name": facility_name,
                                        "location": location_str,
                                        "bridge_length": syogen.get("kyouchou", ""),
                                        "bridge_width": syogen.get("fukuin", ""),
                                        "kanrisya": kanrisya_name,
                                        "rosen": rosen_name,
                                        "feature": feature
                                    }
                                    
                                    # Prevent duplicate candidates since we might query both narrow and wide names
                                    is_duplicate = any(
                                        existing.get('facility_id') == candidate['facility_id']
                                        for existing in search_results[name]
                                    )
                                    
                                    if not is_duplicate:
                                        search_results[name].append(candidate)
                    except Exception as e:
                        print(f"Error fetching {name} from {ep}: {e}")
            
            # Return JSON instead of ZIP
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            response_data = json.dumps({"results": search_results}, ensure_ascii=False)
            self.wfile.write(response_data.encode('utf-8'))
            
        except Exception as e:
            self.send_error(500, f"Server Error: {str(e)}")

    def handle_condition_search_api(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            request_json = json.loads(post_data)
            
            endpoints = request_json.get("endpoints", ["bridges"])
            pref_code = request_json.get("pref_code", "")
            conditions = request_json.get("conditions", {})
            
            print(f"DEBUG CONDITIONS: {conditions}")

            if not endpoints or not pref_code:
                self.send_error(400, "Endpoints and pref_code are required")
                return

            search_results = []
            
            for ep in endpoints:
                offset = 0
                limit = 1000
                total_count = None
                
                while True:
                    params = {'pref': pref_code, 'limit': limit, 'offset': offset}
                    query = urllib.parse.urlencode(params)
                    url = f"https://road-structures-db.mlit.go.jp/xROAD/api/v1/{ep}?{query}"
                    
                    req = urllib.request.Request(url)
                    try:
                        with urllib.request.urlopen(req) as res:
                            body = res.read()
                            data = json.loads(body.decode('utf-8'))
                            
                            if total_count is None:
                                total_count = data.get('resultset', {}).get('count', 0)
                                if total_count == 0:
                                    break
                                    
                            results = data.get('result', [])
                            if not results:
                                break
                                
                            for item in results:
                                flat_item = RequestHandler.flatten_dict(item)
                                
                                syogen = item.get('syogen', {})
                                tenken = item.get('tenken', {})
                                gyousei = syogen.get("gyousei_kuiki", {})
                                ichi_data = syogen.get("ichi", {})
                                
                                item_pref = str(gyousei.get("todoufuken_mei") or ichi_data.get("todofuken_meisyou", ""))
                                item_city = str(gyousei.get("shikuchouson_mei") or ichi_data.get("shikutyouson_meisyou", "")).lower()
                                item_facility = str(syogen.get("shisetsu", {}).get("meisyou", "不明")).lower()
                                item_kanrisya = str(syogen.get("kanrisya", {}).get("meisyou", "")).lower()
                                item_rosen = str(syogen.get("rosen", {}).get("meisyou", "")).lower()
                                
                                # Filtering logic
                                match = True
                                
                                # 1. Generic keywords (search across all flattened values)
                                kw_str = conditions.get("keyword", "").strip()
                                if kw_str:
                                    keywords = [k.strip() for k in kw_str.split() if k.strip()]
                                    
                                    # Enrich search text with Japanese labels attached to their values
                                    enriched_parts = []
                                    # Add all raw values
                                    for v in flat_item.values():
                                        if v is not None:
                                            enriched_parts.append(str(v).lower())
                                            
                                    # Add specific Japanese labels next to their values
                                    label_mapping = {
                                        "syogen_kyouchou": "橋長",
                                        "syogen_fukuin": "幅員",
                                        "tenken_kiroku_hantei_kubun": "判定区分",
                                        "syogen_kasetsu_nendo": "架設",
                                        "syogen_rosen_meisyou": "路線名",
                                        "syogen_kanrisya_meisyou": "管理者",
                                        "syogen_ichi_shikutyouson_meisyou": "市区町村",
                                        "syogen_ichi_todofuken_meisyou": "都道府県",
                                        "syogen_shisetsu_meisyou": "施設名"
                                    }
                                    
                                    for flat_k, flat_v in flat_item.items():
                                        if flat_v is None:
                                            continue
                                        val_str = str(flat_v).lower()
                                        for key_suffix, label in label_mapping.items():
                                            if flat_k.endswith(key_suffix):
                                                enriched_parts.append(f"{label} {val_str}")
                                                enriched_parts.append(f"{label}{val_str}")
                                                
                                    all_values_str = " ".join(enriched_parts)
                                    
                                    for kw in keywords:
                                        if kw.lower() not in all_values_str:
                                            match = False
                                            break
                                            
                                if not match:
                                    continue
                                    
                                # 2. Specific field conditions (partial match)
                                cond_city = conditions.get("city", "").strip().lower()
                                if cond_city and cond_city not in item_city:
                                    continue
                                    
                                cond_rosen = conditions.get("rosen", "").strip().lower()
                                if cond_rosen and cond_rosen not in item_rosen:
                                    continue
                                    
                                cond_kanrisya = conditions.get("kanrisya", "").strip().lower()
                                if cond_kanrisya and cond_kanrisya not in item_kanrisya:
                                    continue
                                    
                                cond_facility = conditions.get("facility_name", "").strip().lower()
                                if cond_facility and cond_facility not in item_facility:
                                    continue
                                    
                                cond_hantei = str(conditions.get("hantei_kubun", "")).strip()
                                if cond_hantei:
                                    # Handle case where tenken is a list vs dict
                                    item_hantei = ""
                                    if isinstance(tenken, list):
                                        for t in tenken:
                                            if isinstance(t, dict):
                                                hk = t.get("kiroku", {}).get("hantei_kubun", "")
                                                if hk:
                                                    item_hantei = str(hk)
                                                    break
                                    elif isinstance(tenken, dict):
                                        item_hantei = str(tenken.get("kiroku", {}).get("hantei_kubun", ""))
                                        
                                    if cond_hantei != item_hantei:
                                        match = False
                                        
                                if not match:
                                    continue
                                    
                                # 3. Numeric range conditions (e.g. length, width)
                                length_min = conditions.get("length_min")
                                length_max = conditions.get("length_max")
                                if (length_min and str(length_min).strip()) or (length_max and str(length_max).strip()):
                                    try:
                                        item_len = float(flat_item.get("syogen_kyouchou", 0))
                                        if length_min and str(length_min).strip() and item_len < float(length_min):
                                            match = False
                                        if length_max and str(length_max).strip() and item_len > float(length_max):
                                            match = False
                                    except (ValueError, TypeError):
                                        match = False
                                        
                                if not match:
                                    continue
                                
                                width_min = conditions.get("width_min")
                                width_max = conditions.get("width_max")
                                if (width_min and str(width_min).strip()) or (width_max and str(width_max).strip()):
                                    try:
                                        item_width = float(flat_item.get("syogen_fukuin", 0))
                                        if width_min and str(width_min).strip() and item_width < float(width_min):
                                            match = False
                                        if width_max and str(width_max).strip() and item_width > float(width_max):
                                            match = False
                                    except (ValueError, TypeError):
                                        match = False
                                        
                                if not match:
                                    continue
                                
                                # If all conditions met, format feature
                                syogen = item.get('syogen', {})
                                tenken = item.get('tenken', {})
                                ido = syogen.get('ichi', {}).get('ido')
                                keido = syogen.get('ichi', {}).get('keido')
                                
                                if ido is not None and keido is not None:
                                    properties = {
                                        "DPF_title": syogen.get("shisetsu", {}).get("meisyou", "不明"),
                                        "RSDB_tenken_kiroku_hantei_kubun": tenken.get("kiroku", {}).get("hantei_kubun", ""),
                                        "kasetsu_nendo": syogen.get("kasetsu_nendo", ""),
                                        "fukuin": syogen.get("fukuin", ""),
                                        "kyouchou": syogen.get("kyouchou", "")
                                    }
                                    
                                    for k, v in flat_item.items():
                                        if k not in properties:
                                            properties[k] = v
                                            
                                    feature = {
                                        "type": "Feature",
                                        "geometry": {
                                            "type": "Point",
                                            "coordinates": [keido, ido]
                                        },
                                        "properties": properties
                                    }
                                    
                                    candidate = {
                                        "facility_id": item.get("shisetsu_id", ""),
                                        "facility_type": ep,
                                        "facility_name": properties["DPF_title"],
                                        "location": f'{syogen.get("ichi", {}).get("todofuken_meisyou", "")}{syogen.get("ichi", {}).get("shikutyouson_meisyou", "")}',
                                        "bridge_length": syogen.get("kyouchou", ""),
                                        "bridge_width": syogen.get("fukuin", ""),
                                        "kanrisya": syogen.get("kanrisya", {}).get("meisyou", ""),
                                        "rosen": syogen.get("rosen", {}).get("meisyou", ""),
                                        "feature": feature
                                    }
                                    search_results.append(candidate)
                                    
                            offset += limit
                            if offset >= total_count:
                                break
                    except Exception as e:
                        print(f"Error fetching from {ep} at offset {offset}: {e}")
                        break
                        
            # Return JSON
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            response_data = json.dumps({"results": search_results}, ensure_ascii=False)
            self.wfile.write(response_data.encode('utf-8'))
            
        except Exception as e:
            self.send_error(500, f"Server Error: {str(e)}")

    def handle_export_api(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            request_json = json.loads(post_data)
            
            features = request_json.get("features", [])
            
            # Create GeoJSON
            geojson = {
                "type": "FeatureCollection",
                "features": features
            }
            geojson_str = json.dumps(geojson, ensure_ascii=False, indent=2)
            
            # Create ZIP
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                # 1. GeoJSON file
                zf.writestr('search_results.geojson', geojson_str.encode('utf-8'))
                
                # 2. QML file
                qml_content = ""
                if os.path.exists(QML_FILE_PATH):
                    with open(QML_FILE_PATH, 'r', encoding='utf-8') as f:
                        qml_content = f.read()
                elif os.path.exists("style_sample.qml"): # Fallback
                     with open("style_sample.qml", 'r', encoding='utf-8') as f:
                        qml_content = f.read()
                
                if qml_content:
                    zf.writestr('search_results.qml', qml_content.encode('utf-8'))
            
            # Send Response
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Disposition', 'attachment; filename="search_results.zip"')
            self.end_headers()
            
            self.wfile.write(zip_buffer.getvalue())
            
        except Exception as e:
            self.send_error(500, f"Server Error: {str(e)}")


def find_free_port(bind_host='localhost'):
    for port in range(8080, 8090):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind((bind_host, port))
            sock.close()
            return port
        except OSError:
            continue
    return 8080

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    settings = load_settings()
    configured_host = str(settings.get("bind_host", "")).strip()
    configured_port = settings.get("port") or 0

    # 未設定時はlocalhost限定+動的ポート（安全側デフォルト）。共有時はbind_host/portを明示指定するopt-in。
    bind_host = configured_host if configured_host else 'localhost'
    if (bind_host not in ('localhost', '127.0.0.1')
            and not str(settings.get('auth', '')).strip()):
        raise SystemExit('LAN公開には appsettings.json の auth 設定が必須です。')
    port = int(configured_port) if configured_port else find_free_port(bind_host)
    server_address = (bind_host, port)

    display_host = bind_host if bind_host not in ('', '0.0.0.0') else 'localhost'
    url = f"http://{display_host}:{port}"
    print("================================")
    print("QGIS構造物検索ツール (xROAD API対応版)")
    print("================================")
    print(f"Server working directory: {script_dir}")
    print(f"Data directory: {resolve_data_dir()}")
    print(f"Starting web server on {url} (bind: {bind_host or '0.0.0.0'})")
    if str(settings.get("auth", "")).strip():
        print("Basic認証: 有効")
    if bind_host not in ('localhost', '127.0.0.1'):
        print("注意: LAN上に公開されています。appsettings.json の auth 設定を確認してください。")
    print("Opening browser...")
    print("Press Ctrl+C to stop the server")
    print("================================")

    def open_browser():
        time.sleep(2)
        webbrowser.open(f"http://localhost:{port}" if bind_host not in ('localhost', '127.0.0.1') else url)

    threading.Thread(target=open_browser, daemon=True).start()

    try:
        httpd = ThreadingHTTPServer(server_address, RequestHandler)
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")

if __name__ == '__main__':
    main()
