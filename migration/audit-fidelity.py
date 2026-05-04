#!/usr/bin/env python3
"""
Verificación: 10 contacts random del source CSV vs Frappe.
Reporta por contact:
  - source non-empty cols
  - frappe campos donde aparece esa data (zd_*, canonical)
  - perdidos (source no-empty pero ningun field frappe los tiene)
"""
import csv, json, os, random, sys, urllib.request, urllib.parse
csv.field_size_limit(sys.maxsize)

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

random.seed(42)


def http(p):
    req = urllib.request.Request(f"{SITE}{p}", headers={"Authorization": AUTH})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def get_frappe_contact(zid):
    fields = json.dumps(["name"])
    flt = json.dumps([["zendesk_id_contact", "=", zid]])
    d = http(f"/api/method/frappe.client.get_list?doctype=Contact"
             f"&filters={urllib.parse.quote(flt)}&fields={urllib.parse.quote(fields)}&limit_page_length=1")
    items = d.get("message", [])
    if not items: return None
    name = items[0]["name"]
    return http(f"/api/resource/Contact/{urllib.parse.quote(name, safe='')}").get("data", {})


def main():
    with open("/tmp/zendesk-export-new/contacts.0.csv") as f:
        rows = list(csv.DictReader(f))
    sample = random.sample(rows, 10)

    total_source_fields = 0
    total_preserved = 0

    for i, src in enumerate(sample, 1):
        zid = src.get("id")
        print(f"\n{'='*80}")
        print(f"[{i}] zendesk_id={zid}  '{src.get('first_name','')} {src.get('last_name','')}'")

        frap = get_frappe_contact(zid)
        if not frap:
            print(f"  ❌ NO ENCONTRADO EN FRAPPE")
            continue

        # All non-empty source values
        src_nonempty = {k: v.strip() for k, v in src.items() if v and v.strip()}
        # All frappe values that are not None/'' and not metadata
        meta = {"name","creation","modified","modified_by","owner","docstatus","idx",
                "doctype","links","email_ids","phone_nos","_user_tags","_comments",
                "_assign","_seen","_liked_by"}
        frap_values = {k: str(v).strip() for k, v in frap.items()
                       if v not in (None, "", 0, [], {}) and k not in meta and not k.startswith("_")}

        preserved = 0
        lost = []
        for src_col, src_val in src_nonempty.items():
            # Check if src_val appears anywhere in frap (substring or exact match)
            sval = src_val.strip()
            found_in = []
            for fk, fv in frap_values.items():
                if sval == fv or (len(sval) > 4 and sval in fv):
                    found_in.append(fk)
            if found_in:
                preserved += 1
            else:
                lost.append((src_col, src_val[:50]))

        total_source_fields += len(src_nonempty)
        total_preserved += preserved

        print(f"  Source non-empty: {len(src_nonempty)} cols")
        print(f"  Preservados en Frappe: {preserved}/{len(src_nonempty)} ({100*preserved/len(src_nonempty):.0f}%)")
        if lost:
            print(f"  PERDIDOS ({len(lost)}):")
            for col, val in lost[:8]:
                print(f"    - {col!r:50s}: {val!r}")

    print(f"\n{'='*80}")
    print(f"TOTAL: {total_preserved}/{total_source_fields} campos preservados ({100*total_preserved/total_source_fields:.1f}%)")


if __name__ == "__main__":
    main()
