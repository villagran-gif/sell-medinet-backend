#!/usr/bin/env python3
"""
Set unique=1 on Contact.rut_normalizado custom field.

Pre-requisito: dedupe-contacts.py debe haberse corrido antes
(no pueden quedar duplicados o el constraint falla al activarse).

Uso:
  python3 migration/add-unique-constraint.py --check     # solo valida que no hay dups
  python3 migration/add-unique-constraint.py --apply     # set unique=1

Env: FRAPPE_CLOUD_SITE_URL, FRAPPE_CLOUD_API_KEY, FRAPPE_CLOUD_API_SECRET
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error
import urllib.parse
from collections import Counter

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

CUSTOM_FIELD_NAME = "Contact-rut_normalizado"


def http(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body else None
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


def find_duplicates():
    """Return dict {rut: [contact_names...]} only for rut with >1 contact."""
    print("=== Listing contacts with rut_normalizado ===")
    all_contacts = []
    page = 0
    fields = json.dumps(["name", "rut_normalizado"])
    while True:
        page += 1
        url = f"/api/method/frappe.client.get_list?doctype=Contact&fields={urllib.parse.quote(fields)}&limit_page_length=200&limit_start={(page-1)*200}"
        code, data = http("GET", url)
        msg = data.get("message", []) if code == 200 else []
        if not msg:
            break
        all_contacts.extend([c for c in msg if c.get("rut_normalizado")])
        if len(msg) < 200:
            break

    counter = Counter(c["rut_normalizado"] for c in all_contacts)
    dups = {rut: [c["name"] for c in all_contacts if c["rut_normalizado"] == rut]
            for rut, n in counter.items() if n > 1}
    print(f"  Total con rut_normalizado: {len(all_contacts)}")
    print(f"  RUTs únicos: {len(counter)}")
    print(f"  RUTs duplicados: {len(dups)} grupos, "
          f"{sum(len(v) for v in dups.values())} contactos affected")
    return dups


def set_unique_constraint():
    """Set unique=1 on Custom Field Contact.rut_normalizado."""
    print(f"\n=== Setting unique=1 on Custom Field {CUSTOM_FIELD_NAME} ===")
    enc = urllib.parse.quote(CUSTOM_FIELD_NAME)
    code, data = http("PUT", f"/api/resource/Custom Field/{enc}", {"unique": 1})
    if code in (200, 202):
        print(f"  ✅ unique=1 applied")
        return True
    else:
        print(f"  ❌ Failed: {code} {json.dumps(data)[:300]}")
        return False


def main():
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true", help="only check for duplicates")
    g.add_argument("--apply", action="store_true", help="apply unique=1 constraint")
    args = p.parse_args()

    if not (SITE and KEY and SECRET):
        sys.exit("FRAPPE_CLOUD_* env vars no seteadas")

    dups = find_duplicates()

    if args.check:
        if dups:
            print("\n  ⚠️  HAY DUPLICADOS — ejecutá dedupe-contacts.py antes")
            sys.exit(1)
        print("\n  ✅ Sin duplicados, listo para aplicar constraint")
        return

    # --apply path
    if dups:
        print("\n  ❌ ABORT — hay duplicados. Correr dedupe-contacts.py primero.")
        sys.exit(2)

    if not set_unique_constraint():
        sys.exit(3)

    # Verify by re-fetching the custom field
    print("\n=== Verification ===")
    enc = urllib.parse.quote(CUSTOM_FIELD_NAME)
    code, data = http("GET", f"/api/resource/Custom Field/{enc}")
    if code == 200:
        unique_val = data.get("data", {}).get("unique")
        print(f"  Custom Field unique flag: {unique_val}")
        if unique_val == 1:
            print(f"  ✅ Constraint active")
        else:
            print(f"  ❌ Constraint NOT applied")
            sys.exit(4)


if __name__ == "__main__":
    main()
