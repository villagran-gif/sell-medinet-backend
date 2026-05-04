#!/usr/bin/env python3
"""
Optimiza UI:
  Convierte Custom Fields zd_* Long Text → Data (max value <= 140 chars)
  o → Small Text (140-1000 chars). Reduce el render gigante en form view.

Frappe bloquea Long Text → Data directo, asi que va Long Text → Small Text → Data.

  python3 migration/optimize-fieldtypes.py --entity contacts
  python3 migration/optimize-fieldtypes.py --entity deals
  python3 migration/optimize-fieldtypes.py --entity leads

Idempotente.
"""
import argparse, csv, json, os, re, sys, urllib.request, urllib.parse, urllib.error

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


ENTITY_CONFIG = {
    "contacts": ("contacts.0.csv", "Contact"),
    "deals":    ("deals.0.csv",    "CRM Deal"),
    "leads":    ("leads.0.csv",    "CRM Lead"),
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--entity", required=True, choices=list(ENTITY_CONFIG.keys()))
    args = p.parse_args()
    csv_name, doctype = ENTITY_CONFIG[args.entity]

    if not (SITE and KEY and SECRET): sys.exit("env")

    # 1. Compute max length per source column from CSV
    with open(f"/tmp/zendesk-export-new/{csv_name}") as f:
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
    flt = json.dumps([["dt","=",doctype],["fieldname","like","zd_%"]])
    code, data = http("GET",
        f"/api/method/frappe.client.get_list?doctype=Custom+Field"
        f"&filters={urllib.parse.quote(flt)}"
        f"&fields=%5B%22name%22%2C%22fieldname%22%2C%22fieldtype%22%5D&limit_page_length=300")
    cf = data.get("message", []) or []
    print(f"zd_* CFs on {doctype}: {len(cf)}")

    # 3. Convert Long Text → Small Text → Data (Frappe permite ese path en 2 pasos)
    converted_data = 0; converted_small = 0; skipped = 0; errors = 0
    for f in cf:
        if f["fieldtype"] != "Long Text":
            skipped += 1; continue
        ml = field_maxlen.get(f["fieldname"], 0)
        if ml <= 140:
            target = "Data"
        elif ml <= 1000:
            target = "Small Text"
        else:
            skipped += 1; continue
        # Step 1: Long Text → Small Text
        code, _ = http("POST", "/api/method/frappe.client.set_value",
                       {"doctype":"Custom Field","name":f["name"],
                        "fieldname":"fieldtype","value":"Small Text"})
        if code not in (200, 202):
            errors += 1
            print(f"  ERR step1 {f['fieldname']}: {code}")
            continue
        if target == "Small Text":
            converted_small += 1
            continue
        # Step 2: Small Text → Data (puede fallar por MySQL row size limit;
        # en ese caso queda como Small Text, igual mucho mejor que Long Text)
        code, resp = http("POST", "/api/method/frappe.client.set_value",
                       {"doctype":"Custom Field","name":f["name"],
                        "fieldname":"fieldtype","value":"Data"})
        if code in (200, 202):
            converted_data += 1
        elif "Row size too large" in json.dumps(resp):
            converted_small += 1  # quedó como Small Text, OK
        else:
            errors += 1
            print(f"  ERR step2 {f['fieldname']}: {code}")

    print(f"  Long Text → Data: {converted_data}")
    print(f"  Long Text → Small Text: {converted_small}")
    print(f"  Skipped: {skipped}")
    print(f"  Errors: {errors}")


if __name__ == "__main__":
    main()
