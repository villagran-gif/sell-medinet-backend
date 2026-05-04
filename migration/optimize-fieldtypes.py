#!/usr/bin/env python3
"""
Optimiza UI:
  1. Convierte Custom Fields Long Text → Data (max value <= 140 chars)
     → render mucho mas liviano (input simple en vez de textarea grande)
  2. Convierte Long Text → Small Text si max <= 1000
  3. Recalcula list view default a ~20 columnas mas utiles

Idempotente.
"""
import csv, json, os, re, sys, urllib.request, urllib.parse, urllib.error

csv.field_size_limit(sys.maxsize)

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"


def snake(s):
    s = (s or "").strip()
    repl = {"á":"a","é":"e","í":"i","ó":"o","ú":"u","ñ":"n",
            "Á":"a","É":"e","Í":"i","Ó":"o","Ú":"u","Ñ":"n",
            " ":"_","/":"_",".":"_","(":"",")":"","#":"","*":"",
            "\\":"_",":":"_","-":"_","+":"_",",":"_","'":"","\"":"",
            "?":"","¿":"","!":"","¡":"","&":"_and_"}
    for k,v in repl.items(): s=s.replace(k,v)
    s = re.sub(r"[^a-zA-Z0-9_]","",s)
    s = re.sub(r"_+","_",s).strip("_").lower()
    return s


def http(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
        headers={"Authorization": AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except: return e.code, {}


def main():
    if not (SITE and KEY and SECRET): sys.exit("env")

    # 1. Compute max length per source column from CSV
    with open("/tmp/zendesk-export-new/contacts.0.csv") as f:
        rows = list(csv.DictReader(f))
    src_maxlen = {}
    for r in rows:
        for k, v in r.items():
            if v: src_maxlen[k] = max(src_maxlen.get(k,0), len(v))
    field_maxlen = {}
    for src, ml in src_maxlen.items():
        f = f"zd_{snake(src)}"[:64]
        field_maxlen[f] = max(field_maxlen.get(f, 0), ml)

    # 2. Get current Custom Fields
    code, data = http("GET",
        "/api/method/frappe.client.get_list?doctype=Custom+Field"
        "&filters=%5B%5B%22dt%22%2C%22%3D%22%2C%22Contact%22%5D%2C%5B%22fieldname%22%2C%22like%22%2C%22zd_%25%22%5D%5D"
        "&fields=%5B%22name%22%2C%22fieldname%22%2C%22fieldtype%22%5D&limit_page_length=200")
    cf = data.get("message", []) or []
    print(f"Current Custom Fields zd_* on Contact: {len(cf)}")

    # 3. Convert Long Text → Data / Small Text
    converted_data = 0; converted_small = 0; skipped = 0
    for f in cf:
        if f["fieldtype"] != "Long Text":
            skipped += 1; continue
        ml = field_maxlen.get(f["fieldname"], 0)
        if ml <= 140:
            new_type = "Data"
        elif ml <= 1000:
            new_type = "Small Text"
        else:
            skipped += 1; continue
        code, _ = http("PUT", f"/api/resource/Custom+Field/{urllib.parse.quote(f['name'], safe='')}",
                       {"fieldtype": new_type})
        if code in (200, 202):
            if new_type == "Data": converted_data += 1
            else: converted_small += 1
        else:
            print(f"  ERR {f['name']} → {new_type}: {code}")

    print(f"  Long Text → Data: {converted_data}")
    print(f"  Long Text → Small Text: {converted_small}")
    print(f"  Skipped (already Data/etc o muy largo): {skipped}")


if __name__ == "__main__":
    main()
