#!/usr/bin/env python3
"""
Marca como hidden=1 los Custom Fields zd_* en Contact con baja cobertura
(<5% datos). Asi el column picker del FCRM no los lista, y el Vue componente
de form layout es mas liviano.

Idempotente. La data sigue en DB; setear hidden=0 los muestra de nuevo.
"""
import csv, json, os, re, sys, urllib.request, urllib.parse, urllib.error
csv.field_size_limit(sys.maxsize)

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

THRESHOLD_PCT = 5.0

# Always keep visible (default list view + form-useful)
ALWAYS_VISIBLE = {
    "zd_owner", "zd_creator", "zd_customer_status", "zd_prospect_status",
    "zd_city", "zd_custom_contact_edad", "zd_custom_contact_prevision",
    "zd_last_activity_date", "zd_first_name", "zd_last_name", "zd_email",
    "zd_mobile", "zd_phone", "zd_address", "zd_id", "zd_name",
    "zd_custom_contact_rut_normalizado", "zd_custom_contact_rut_o_id",
    "zd_custom_contact_telefono", "zd_custom_contact_correo_electronico",
    "zd_custom_contact_ciudad", "zd_custom_contact_imc",
    "zd_custom_contact_fecha_nacimiento",
    "zd_custom_contact_fecha_ingresa_formulario",
    "zd_organisation_name",  # for orgs
}


def snake(s):
    s = (s or "").strip()
    repl = {"á":"a","é":"e","í":"i","ó":"o","ú":"u","ñ":"n",
            "Á":"a","É":"e","Í":"i","Ó":"o","Ú":"u","Ñ":"n",
            " ":"_","/":"_",".":"_","(":"",")":"","#":"","*":"",
            "\\":"_",":":"_","-":"_","+":"_",",":"_","'":"","\"":"",
            "?":"","¿":"","!":"","¡":"","&":"_and_"}
    for k,v in repl.items(): s = s.replace(k,v)
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

    # Compute coverage per fieldname from source CSV
    with open("/tmp/zendesk-export-new/contacts.0.csv") as f:
        rows = list(csv.DictReader(f))
    total = len(rows)
    src_count = {}
    for r in rows:
        for k, v in r.items():
            if v: src_count[k] = src_count.get(k, 0) + 1
    field_cov = {}
    for src, n in src_count.items():
        fname = f"zd_{snake(src)}"[:64]
        field_cov[fname] = max(field_cov.get(fname, 0), n)

    # Get current zd_* CFs
    code, data = http("GET",
        "/api/method/frappe.client.get_list?doctype=Custom+Field"
        "&filters=%5B%5B%22dt%22%2C%22%3D%22%2C%22Contact%22%5D%2C%5B%22fieldname%22%2C%22like%22%2C%22zd_%25%22%5D%5D"
        "&fields=%5B%22name%22%2C%22fieldname%22%2C%22hidden%22%5D&limit_page_length=200")
    cf = data.get("message", []) or []

    threshold_count = total * THRESHOLD_PCT / 100.0
    to_hide = []
    keep = []
    for f in cf:
        fname = f["fieldname"]
        cov = field_cov.get(fname, 0)
        if fname in ALWAYS_VISIBLE or cov >= threshold_count:
            keep.append(fname)
        else:
            to_hide.append((f["name"], fname, cov))

    print(f"Total zd_* on Contact: {len(cf)}")
    print(f"Keeping visible: {len(keep)}")
    print(f"Hiding (cov < {THRESHOLD_PCT}%): {len(to_hide)}")

    hidden = 0; errors = 0
    for cf_name, fname, cov in to_hide:
        code, _ = http("POST", "/api/method/frappe.client.set_value",
                       {"doctype": "Custom Field", "name": cf_name,
                        "fieldname": "hidden", "value": 1})
        if code in (200, 202):
            hidden += 1
        else:
            errors += 1
            print(f"  ERR hiding {fname}: code={code}")

    print(f"\nHidden: {hidden}")
    print(f"Errors: {errors}")
    print("\nNote: para volver a mostrar uno, setear hidden=0 en su Custom Field.")


if __name__ == "__main__":
    main()
