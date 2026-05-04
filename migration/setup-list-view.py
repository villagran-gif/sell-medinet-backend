#!/usr/bin/env python3
"""
Configura la list view del FCRM para Contact con un set MANEJABLE de columnas
default (canonicals + zd_* mas utiles). 137 columnas hicieron crashear el
browser. El picker permite agregar mas manualmente.

Idempotente.
"""
import os, json, sys, urllib.request, urllib.parse, urllib.error

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"


def http(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
        headers={"Authorization": AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {"_raw": e.read().decode("utf-8", errors="replace")[:500]}


# Type mapping Frappe fieldtype → list view type
TYPE_MAP = {
    "Data": "Data", "Long Text": "Long Text", "Text Editor": "Text Editor",
    "Text": "Text", "Small Text": "Small Text",
    "Date": "Date", "Datetime": "Datetime", "Time": "Time",
    "Int": "Int", "Float": "Float", "Currency": "Currency",
    "Check": "Check", "Select": "Select", "Link": "Link",
    "Dynamic Link": "Dynamic Link", "Percent": "Percent",
}


def main():
    if not (SITE and KEY and SECRET): sys.exit("env")

    # 1. Listar todos los Custom Fields en Contact
    fields_url = ("/api/method/frappe.client.get_list?doctype=Custom%20Field"
                  "&filters=%5B%5B%22dt%22%2C%22%3D%22%2C%22Contact%22%5D%5D"
                  "&fields=%5B%22fieldname%22%2C%22fieldtype%22%2C%22label%22%5D"
                  "&limit_page_length=500&order_by=idx")
    code, data = http("GET", fields_url)
    cf = data.get("message", []) or []
    print(f"Custom fields on Contact: {len(cf)}")

    # 2. Construir columnas + rows
    # Canonicals first (las útiles)
    canonical_cols = [
        {"label": "Nombre", "key": "full_name", "type": "Data", "width": "14rem"},
        {"label": "Email", "key": "email_id", "type": "Data", "width": "14rem"},
        {"label": "Móvil", "key": "mobile_no", "type": "Data", "width": "12rem"},
        {"label": "Teléfono", "key": "phone", "type": "Data", "width": "12rem"},
        {"label": "Organización", "key": "company_name", "type": "Data", "width": "12rem"},
        {"label": "RUT", "key": "rut_normalizado", "type": "Data", "width": "10rem"},
        {"label": "Zendesk ID", "key": "zendesk_id_contact", "type": "Data", "width": "10rem"},
        {"label": "Modificado", "key": "modified", "type": "Datetime", "width": "10rem"},
    ]
    canonical_keys = {c["key"] for c in canonical_cols}

    cf_cols = []
    for f in cf:
        fname = f["fieldname"]
        if fname in canonical_keys: continue
        cf_cols.append({
            "label": f.get("label") or fname,
            "key": fname,
            "type": TYPE_MAP.get(f.get("fieldtype"), "Data"),
            "width": "12rem",
        })

    columns = canonical_cols + cf_cols
    rows_keys = ["name"] + [c["key"] for c in columns]

    print(f"Total columns: {len(columns)} (canonical {len(canonical_cols)} + custom {len(cf_cols)})")

    # 3. PUT en CRM View Settings id=2
    body = {
        "columns": json.dumps(columns, ensure_ascii=False),
        "rows": json.dumps(rows_keys, ensure_ascii=False),
        "order_by": "modified desc",
    }
    code, resp = http("PUT", "/api/resource/CRM%20View%20Settings/2", body)
    if code in (200, 202):
        print("PUT OK on CRM View Settings #2")
    else:
        print(f"ERR {code}: {resp}")


if __name__ == "__main__":
    main()
