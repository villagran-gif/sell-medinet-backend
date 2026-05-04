#!/usr/bin/env python3
"""
Borra Custom Fields de Contact identificados como basura:
  - 10 vacios (0% data en 8807 contacts)
  - ~60 variantes #1..#5 generadas por admins en Zendesk Sell

Criterio: source col contiene '#' → variante (a borrar).
Plus la lista explicita de los 10 vacios.

Idempotente. NO borra la data canonica (sin sufijo).
"""
import json, os, re, sys, urllib.request, urllib.parse, urllib.error
from collections import defaultdict

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

DISCOVERY = "/tmp/migration/discovery.json"

EMPTY_FIELDS = {
    "zd_creator_id", "zd_custom_contact_industry", "zd_fax", "zd_industry",
    "zd_linkedin", "zd_linkedin_display", "zd_private", "zd_skype",
    "zd_twitter", "zd_user_id",
}


def snake(s):
    s = (s or "").strip()
    repl = {"á":"a","é":"e","í":"i","ó":"o","ú":"u","ñ":"n",
            "Á":"a","É":"e","Í":"i","Ó":"o","Ú":"u","Ñ":"n",
            " ":"_", "/":"_", ".":"_", "(":"", ")":"", "#":"", "*":"",
            "\\":"_", ":":"_", "-":"_", "+":"_", ",":"_", "'":"", "\"":"",
            "?":"", "¿":"", "!":"", "¡":"", "&":"_and_"}
    for k, v in repl.items(): s = s.replace(k, v)
    s = re.sub(r"[^a-zA-Z0-9_]", "", s)
    s = re.sub(r"_+", "_", s).strip("_").lower()
    return s


def http(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
        headers={"Authorization": AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {"_raw": e.read().decode("utf-8", errors="replace")[:300]}


def find_cf_name(dt, fieldname):
    flt = json.dumps([["dt", "=", dt], ["fieldname", "=", fieldname]])
    code, data = http("GET",
        f"/api/method/frappe.client.get_list?doctype=Custom+Field"
        f"&filters={urllib.parse.quote(flt)}&fields=%5B%22name%22%5D&limit_page_length=1")
    items = data.get("message", []) if code == 200 else []
    return items[0]["name"] if items else None


def main():
    if not (SITE and KEY and SECRET): sys.exit("env")

    disc = json.load(open(DISCOVERY))
    cols = disc["entities"]["contacts"]["cols"]

    # Variants: source col contains '#'
    variants = set()
    for c in cols:
        if "#" in c:
            base = snake(c)
            variants.add(f"zd_{base}"[:64])

    targets = sorted(EMPTY_FIELDS | variants)
    print(f"Empty: {len(EMPTY_FIELDS)}, variants: {len(variants)}, "
          f"unique total: {len(targets)}")

    deleted = 0; not_found = 0; errors = 0
    for fname in targets:
        cf_name = find_cf_name("Contact", fname)
        if not cf_name:
            not_found += 1; continue
        code, _ = http("POST", "/api/method/frappe.client.delete",
                       {"doctype": "Custom Field", "name": cf_name})
        if code in (200, 202, 204):
            deleted += 1
        else:
            errors += 1
            print(f"  ERR deleting {fname} ({cf_name}): code={code}")

    print(f"\nDeleted: {deleted}")
    print(f"Not found: {not_found}")
    print(f"Errors: {errors}")


if __name__ == "__main__":
    main()
