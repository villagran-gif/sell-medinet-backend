#!/usr/bin/env python3
"""
Resuelve deal.contact_links para los CRM Deals importados.

Después de import-from-csv.py --entity deals, los deals tienen el field
custom `main_contact_id_zendesk` (string con el Zendesk contact ID original)
pero NO tienen el link a Frappe Contact que corresponde.

Este script:
  1. Lista todos los CRM Deal con main_contact_id_zendesk poblado
  2. Para cada uno, lee el RUT del deal o resuelve via lookup Zendesk-CSV
  3. Encuentra el Contact en Frappe que tiene ese rut_normalizado
  4. Setea contact_links = [{"link_doctype":"Contact","link_name":<frappe_name>}]
  5. Reporta unmatched

Pre-requisitos:
  - Contact import completado (con rut_normalizado)
  - Deal import completado (con custom main_contact_id_zendesk + rut/rut_normalizado)
  - dedupe-contacts.py corrido (un Contact por RUT)

Uso:
  python3 migration/resolve-deal-contacts.py --dry-run
  python3 migration/resolve-deal-contacts.py --apply
  python3 migration/resolve-deal-contacts.py --apply --batch 100  # process N at a time

Env: FRAPPE_CLOUD_SITE_URL, FRAPPE_CLOUD_API_KEY, FRAPPE_CLOUD_API_SECRET
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error
import urllib.parse
import re
from collections import Counter

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"


def http(method, path, body=None, timeout=30, retries=3):
    data = json.dumps(body).encode() if body else None
    for attempt in range(retries):
        req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
            headers={"Authorization": AUTH, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read())
            except json.JSONDecodeError:
                return e.code, {"_raw": "(non-json)"}
        except (TimeoutError, urllib.error.URLError) as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            return 599, {"_raw": str(e)}


def normalize_rut(rut):
    """Strip non-alphanumeric, uppercase. Returns '' if invalid."""
    if not rut:
        return ""
    s = re.sub(r"[^0-9Kk]", "", str(rut).upper())
    if not (7 <= len(s) <= 10) or not re.match(r"^\d+[0-9K]$", s):
        return ""
    return s


def list_all(doctype, fields, filters=None, limit=200):
    """Paginate through all records of a doctype."""
    out = []
    page = 0
    fields_str = json.dumps(fields)
    filters_str = json.dumps(filters) if filters else None
    while True:
        page += 1
        url = (f"/api/method/frappe.client.get_list?doctype={urllib.parse.quote(doctype)}"
               f"&fields={urllib.parse.quote(fields_str)}"
               f"&limit_page_length={limit}&limit_start={(page-1)*limit}")
        if filters_str:
            url += f"&filters={urllib.parse.quote(filters_str)}"
        code, data = http("GET", url)
        msg = data.get("message", []) if code == 200 else []
        out.extend(msg)
        if len(msg) < limit:
            break
    return out


def update_deal_contact(deal_name, contact_name):
    """Set Deal primary contact (Link) and contacts child table (CRM Contacts)."""
    enc = urllib.parse.quote(deal_name)
    body = {
        "contact": contact_name,
        "contacts": [
            {"contact": contact_name, "is_primary": 1}
        ]
    }
    code, data = http("PUT", f"/api/resource/CRM%20Deal/{enc}", body)
    return code in (200, 202), data


def main():
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--apply", action="store_true")
    p.add_argument("--batch", type=int, default=0, help="solo procesar N deals (0=all)")
    args = p.parse_args()

    if not (SITE and KEY and SECRET):
        sys.exit("FRAPPE_CLOUD_* env vars no seteadas")

    print("=== Building Contact RUT index ===")
    contacts = list_all("Contact", ["name", "rut_normalizado"])
    rut_index = {}
    for c in contacts:
        rut = normalize_rut(c.get("rut_normalizado"))
        if rut:
            rut_index[rut] = c["name"]
    print(f"  Indexed {len(rut_index)} contacts by RUT")

    print("\n=== Listing deals needing contact resolution ===")
    deals = list_all("CRM Deal",
                     ["name", "rut_normalizado"],
                     filters=[["rut_normalizado", "is", "set"]])
    print(f"  Total deals con rut_normalizado: {len(deals)}")

    if args.batch:
        deals = deals[:args.batch]
        print(f"  Limit a primeros {args.batch}")

    stats = Counter()
    started = time.time()
    for i, deal in enumerate(deals, 1):
        rut = normalize_rut(deal.get("rut_normalizado"))
        if not rut:
            stats["invalid_rut"] += 1
            continue

        contact_name = rut_index.get(rut)
        if not contact_name:
            stats["no_contact_for_rut"] += 1
            if args.dry_run and stats["no_contact_for_rut"] <= 5:
                print(f"  [no match] deal={deal['name']} rut={rut}")
            continue

        if args.dry_run:
            stats["would_link"] += 1
            if stats["would_link"] <= 5:
                print(f"  [LINK] deal={deal['name']} → contact={contact_name} (rut={rut})")
            continue

        ok, _ = update_deal_contact(deal["name"], contact_name)
        if ok:
            stats["linked"] += 1
        else:
            stats["link_err"] += 1

        if i % 100 == 0:
            elapsed = time.time() - started
            rate = i / elapsed if elapsed else 0
            print(f"  ... {i}/{len(deals)} in {elapsed:.0f}s ({rate:.1f}/s) {dict(stats)}")

    print(f"\n=== Done ===")
    print(f"  Stats: {dict(stats)}")
    print(f"  Total time: {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
