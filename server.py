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
        elif self.path == '/api/export':
            self.handle_export_api()
        else:
            self.send_error(404, "Endpoint not found")
            
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
                                    def flatten_dict(d, parent_key='', sep='_'):
                                        items = []
                                        for k, v in d.items():
                                            new_key = f"{parent_key}{sep}{k}" if parent_key else k
                                            if isinstance(v, dict):
                                                items.extend(flatten_dict(v, new_key, sep=sep).items())
                                            else:
                                                items.append((new_key, v))
                                        return dict(items)
                                        
                                    flat_item = flatten_dict(item)
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
