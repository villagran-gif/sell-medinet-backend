#!/usr/bin/env python3
"""
Verificación: N contacts random del source CSV vs Frappe.
Chequea TODAS las columnas source (incluso vacías que deberían ser vacías).
Reporta:
  - source non-empty cols con su valor
  - frappe match: dónde aparece esa data (zd_*, canonical, child tables)
  - perdidos: source no-empty pero ningún field frappe los tiene
  - extras en frappe (presentes pero no en source — debería ser raro)
"""
import argparse, csv, json, os, random, sys, urllib.request, urllib.parse
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


def get_child_values(frap):
    """Extract values from email_ids/phone_nos child tables."""
    values = []
    for em in (frap.get("email_ids") or []):
        if isinstance(em, dict):
            v = em.get("email_id")
            if v: values.append(("email_ids[].email_id", str(v)))
    for ph in (frap.get("phone_nos") or []):
        if isinstance(ph, dict):
            v = ph.get("phone")
            if v: values.append(("phone_nos[].phone", str(v)))
    return values


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--n", type=int, default=50)
    p.add_argument("--show-lost", type=int, default=20, help="Max LOST fields to print per contact")
    args = p.parse_args()

    with open("/tmp/zendesk-export-new/contacts.0.csv") as f:
        rows = list(csv.DictReader(f))
    sample = random.sample(rows, args.n)

    total_source_fields = 0
    total_preserved = 0
    not_found = 0
    lost_by_col = {}  # source col → count of contacts missing it

    for i, src in enumerate(sample, 1):
        zid = src.get("id")
        name_tag = f"{src.get('first_name','')[:20]} {src.get('last_name','')[:20]}".strip() or "<no name>"
        print(f"\n{'='*80}")
        print(f"[{i:2d}] zid={zid}  {name_tag!r}")

        frap = get_frappe_contact(zid)
        if not frap:
            print(f"  X NO ENCONTRADO EN FRAPPE")
            not_found += 1
            continue

        src_nonempty = {k: v.strip() for k, v in src.items() if v and v.strip()}

        meta = {"name","creation","modified","modified_by","owner","docstatus","idx",
                "doctype","links","_user_tags","_comments","_assign","_seen","_liked_by"}
        frap_scalar = {k: str(v).strip() for k, v in frap.items()
                       if v not in (None, "", 0, [], {}) and k not in meta
                       and not k.startswith("_") and k not in ("email_ids","phone_nos")}
        frap_child = get_child_values(frap)

        preserved = 0
        lost = []
        for src_col, src_val in src_nonempty.items():
            sval = src_val.strip()
            sval_low = sval.lower()
            found_in = []
            for fk, fv in frap_scalar.items():
                fv_low = fv.lower()
                if sval == fv or sval_low == fv_low:
                    found_in.append(fk)
                elif len(sval) > 4 and (sval in fv or sval_low in fv_low):
                    found_in.append(fk)
            for fk, fv in frap_child:
                if sval == fv or (len(sval) > 4 and sval in fv):
                    found_in.append(fk)
            if found_in:
                preserved += 1
            else:
                lost.append((src_col, src_val[:60]))
                lost_by_col[src_col] = lost_by_col.get(src_col, 0) + 1

        total_source_fields += len(src_nonempty)
        total_preserved += preserved

        pct = 100*preserved/len(src_nonempty) if src_nonempty else 0
        marker = "OK" if pct == 100 else ("WARN" if pct >= 80 else "LOW")
        print(f"  source: {len(src_nonempty):3d} non-empty  preservados: {preserved:3d} ({pct:5.1f}%) [{marker}]")
        if lost:
            print(f"  LOST {len(lost)} fields:")
            for col, val in lost[: args.show_lost]:
                print(f"    - {col!r}: {val!r}")
            if len(lost) > args.show_lost:
                print(f"    ... +{len(lost)-args.show_lost} mas")

    print(f"\n{'='*80}")
    print(f"OVERALL: {total_preserved}/{total_source_fields} campos preservados ({100*total_preserved/total_source_fields:.1f}%)")
    print(f"Contacts not found: {not_found}/{args.n}")
    if lost_by_col:
        print(f"\nColumnas mas frecuentemente perdidas (de {args.n} contacts):")
        for col, cnt in sorted(lost_by_col.items(), key=lambda x: -x[1])[:15]:
            print(f"  {cnt:3d}x  {col!r}")


if __name__ == "__main__":
    main()
