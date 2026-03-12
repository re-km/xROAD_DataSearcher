import os
import sys
import json
import time
import urllib.request
import urllib.parse
import unicodedata
from http.server import HTTPServer, SimpleHTTPRequestHandler
import socket
import threading
import webbrowser
import io
import zipfile
import cgi
from google import genai
from google.genai import types
import fitz  # PyMuPDF

# API Endpoint
XROAD_API_URL = "https://road-structures-db.mlit.go.jp/xROAD/api/v1/bridges"

# Target QML file
QML_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "style_sample.qml")

class RequestHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/extract':
            self.handle_extract_api()
        elif self.path == '/api/search':
            self.handle_search_api()
        elif self.path == '/api/condition_search':
            self.handle_condition_search_api()
        elif self.path == '/api/export':
            self.handle_export_api()
        else:
            self.send_error(404, "Endpoint not found")
            
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
        doc = fitz.open(stream=file_data, filetype="pdf")
        text = ""
        for page in doc:
            text += page.get_text()
        return text

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
            import os
            if not os.environ.get("GEMINI_API_KEY"):
                raise ValueError("GEMINI_API_KEYが設定されていません。AI機能を使用するには環境変数にAPIキーを設定してください。")

            # Call Gemini
            client = genai.Client()
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
                config=types.GenerateContentConfig(
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
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            self.wfile.write(json.dumps({"names": extracted_names}, ensure_ascii=False).encode('utf-8'))
            
        except ValueError as ve:
            self.send_response(400)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(str(ve).encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
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
                                    facility_pref = ichi_data.get("todofuken_meisyou", "不明")
                                    facility_city = ichi_data.get("shikutyouson_meisyou", "")
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
            self.send_header('Access-Control-Allow-Origin', '*')
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
            self.send_header('Access-Control-Allow-Origin', '*')
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
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            self.wfile.write(zip_buffer.getvalue())
            
        except Exception as e:
            self.send_error(500, f"Server Error: {str(e)}")


def find_free_port():
    for port in range(8080, 8090):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(('localhost', port))
            sock.close()
            return port
        except OSError:
            continue
    return 8080

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)
    
    port = find_free_port()
    server_address = ('', port)
    
    url = f"http://localhost:{port}"
    print("================================")
    print("QGIS構造物検索ツール (xROAD API対応版)")
    print("================================")
    print(f"Server working directory: {script_dir}")
    print(f"Starting web server on {url}")
    print("Opening browser...")
    print("Press Ctrl+C to stop the server")
    print("================================")
    
    def open_browser():
        time.sleep(2)
        webbrowser.open(url)
    
    threading.Thread(target=open_browser, daemon=True).start()
    
    try:
        httpd = HTTPServer(server_address, RequestHandler)
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")

if __name__ == '__main__':
    main()
