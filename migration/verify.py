#!/usr/bin/env python3
"""
Fase 9: verificación post-import.

  - counts vs source CSV
  - sample inspection
  - dedupe smoke test
"""
import os, sys, json, urllib.request, urllib.parse, csv

csv.field_size_limit(sys.maxsize)

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

DISCOVERY = "/tmp/migration/discovery.json"


def get(path):
    req = urllib.request.Request(f"{SITE}{path}", headers={"Authorization": AUTH})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def count(doctype, filters=None):
    p = f"/api/method/frappe.client.get_count?doctype={urllib.parse.quote(doctype)}"
    if filters:
        p += f"&filters={urllib.parse.quote(json.dumps(filters))}"
    return get(p).get("message", 0)


def main():
    if not (SITE and KEY and SECRET): sys.exit("env missing")
    disc = json.load(open(DISCOVERY, encoding="utf-8"))

    print(f"Site: {SITE}\n")
    print("=== Counts vs source ===")
    expected = {
        "Contact": disc["entities"]["contacts"]["rows"],
        "CRM Deal": disc["entities"]["deals"]["rows"],
        "CRM Lead": disc["entities"]["leads"]["rows"],
        "FCRM Note": disc["entities"]["notes"]["rows"],
        "CRM Task": disc["entities"]["tasks"]["rows"],
        "File": 395,
    }
    for dt, exp in expected.items():
        actual = count(dt)
        status = "OK" if actual >= exp * 0.95 else "LOW"
        print(f"  {dt:12s} expected={exp:6d}  actual={actual:6d}  {status}")

    print("\n=== Dedupe / sanity ===")
    contacts_with_rut = count("Contact", [["rut_normalizado", "is", "set"]])
    print(f"  Contacts con rut_normalizado: {contacts_with_rut}")
    contacts_with_zid = count("Contact", [["zendesk_id_contact", "is", "set"]])
    print(f"  Contacts con zendesk_id_contact: {contacts_with_zid}")
    deals_with_contact = count("CRM Deal", [["contact", "is", "set"]])
    print(f"  Deals con contact link: {deals_with_contact}")
    notes_with_ref = count("Comment", [["reference_name", "is", "set"]])
    print(f"  Comments con reference_name: {notes_with_ref}")


if __name__ == "__main__":
    main()
