import urllib.request
import json
import urllib.parse
import unicodedata

def search(query):
    url = "https://road-structures-db.mlit.go.jp/xROAD/api/v1/bridges?" + urllib.parse.urlencode({"name": query, "limit": 1})
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req) as res:
            j = json.loads(res.read().decode("utf-8"))
            return len(j.get("result", [])) > 0
    except:
        return False

def make_queries(basename):
    queries = [basename]
    narrow = unicodedata.normalize("NFKC", basename).replace(" ", "").replace("　", "")
    if narrow != basename:
        queries.append(narrow)
    
    wide = ""
    for char in narrow:
        code = ord(char)
        if 0x21 <= code <= 0x7E:
            wide += chr(code + 0xFEE0)
        else:
            wide += char
            
    if wide != basename and wide != narrow:
        queries.append(wide)
    return list(set(queries))

print("Testing 神通川2号橋")
for q in make_queries("神通川2号橋"):
    print(f"  Query '{q}' -> {search(q)}")
