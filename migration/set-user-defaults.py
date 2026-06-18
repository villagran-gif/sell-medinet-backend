#!/usr/bin/env python3
"""
Setea defaults UI para TODOS los usuarios habilitados del site Frappe CRM:

  1. `desk_theme = "Dark"`           → fondo oscuro en /app/ y /crm/
  2. `default_app = "crm"`           → al loguear redirige a /crm/ (FCRM)
                                       en vez del desk Frappe.

Y crea Property Setters equivalentes para que los users *nuevos* arranquen
con los mismos defaults sin tocar nada.

Idempotente:
  - skip users que ya tienen el valor target
  - los Property Setters existentes con el value correcto no se recrean

Read-only sin --execute.

Env requeridas:
  FRAPPE_CLOUD_SITE_URL    https://crm-yqh-dgj.m.frappe.cloud
  FRAPPE_CLOUD_API_KEY     per-user API key
  FRAPPE_CLOUD_API_SECRET  per-user API secret

Usage:
  python3 migration/set-user-defaults.py            # dry-run
  python3 migration/set-user-defaults.py --execute  # aplica

Notas:
  - Frappe v15+ usa `desk_theme` para tematizar tanto /app/ como /crm/.
  - `default_app="crm"` es la forma soportada de redirigir login a FCRM.
    El landing específico dentro de /crm/ (Deals vs Dashboard) depende del
    routing del frontend FCRM; este script setea el default a nivel Frappe.
    Si el agente quiere que el landing sea EXACTAMENTE Deals, puede ir a
    /crm/deals/view/list una vez y FCRM recuerda la última view.
  - Cada usuario sigue pudiendo overridear desde 'My Settings' → Theme.
  - Se filtra `Administrator` y `Guest` (system users) por seguridad.
"""
import os, sys, json, time, urllib.request, urllib.error, urllib.parse

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

# Field → desired value
USER_DEFAULTS = {
    "desk_theme": "Dark",
    "default_app": "crm",
}

# Value to seed via Property Setter (DocField default) — para users nuevos
PROPERTY_DEFAULTS = {
    "desk_theme": "Dark",
    "default_app": "crm",
}

SKIP_USERS = {"Administrator", "Guest"}


def http(method, path, body=None, timeout=30, retries=3):
    data = json.dumps(body).encode() if body else None
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            f"{SITE}{path}", data=data, method=method,
            headers={"Authorization": AUTH, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", errors="replace")
            if e.code >= 500 and attempt < retries - 1:
                time.sleep(2 ** attempt); continue
            try: return e.code, json.loads(text)
            except Exception: return e.code, {"_raw": text[:300]}
        except (TimeoutError, urllib.error.URLError, ConnectionError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt); continue
            return 599, {"_raw": str(e)}
    return 599, {"_raw": str(last)}


def get_users():
    fields = ["name", "user_type", "enabled"] + list(USER_DEFAULTS.keys())
    qs = urllib.parse.urlencode({
        "fields": json.dumps(fields),
        "filters": '[["enabled","=",1]]',
        "limit_page_length": 0,
    })
    code, resp = http("GET", f"/api/resource/User?{qs}")
    if code != 200:
        print(f"ERROR listando users: code={code} resp={json.dumps(resp)[:200]}")
        sys.exit(1)
    return [u for u in (resp.get("data") or []) if u["name"] not in SKIP_USERS]


def set_user_field(name, fieldname, value):
    return http(
        "POST",
        "/api/method/frappe.client.set_value",
        {"doctype": "User", "name": name, "fieldname": fieldname, "value": value},
    )


def get_property_setter(field_name):
    qs = urllib.parse.urlencode({
        "fields": '["name","value"]',
        "filters": json.dumps([
            ["doc_type", "=", "User"],
            ["field_name", "=", field_name],
            ["property", "=", "default"],
        ]),
        "limit_page_length": 0,
    })
    code, resp = http("GET", f"/api/resource/Property Setter?{qs}")
    if code != 200:
        return None
    items = resp.get("data") or []
    return items[0] if items else None


def upsert_property_setter(field_name, value):
    existing = get_property_setter(field_name)
    if existing:
        if existing.get("value") == value:
            return "EXISTS_OK"
        code, resp = http(
            "POST",
            "/api/method/frappe.client.set_value",
            {
                "doctype": "Property Setter",
                "name": existing["name"],
                "fieldname": "value",
                "value": value,
            },
        )
        return "OK_UPDATE" if code in (200, 201) else f"ERR_UPDATE: {json.dumps(resp)[:200]}"
    doc = {
        "doctype": "Property Setter",
        "doctype_or_field": "DocField",
        "doc_type": "User",
        "field_name": field_name,
        "property": "default",
        "value": value,
        "property_type": "Data",
    }
    code, resp = http("POST", "/api/method/frappe.client.insert", {"doc": doc})
    return "OK_INSERT" if code in (200, 201) else f"ERR_INSERT: {json.dumps(resp)[:200]}"


def validate_env():
    missing = [v for v in ("FRAPPE_CLOUD_SITE_URL", "FRAPPE_CLOUD_API_KEY", "FRAPPE_CLOUD_API_SECRET")
               if not os.environ.get(v)]
    if missing:
        print(f"ERROR: faltan env vars: {', '.join(missing)}")
        sys.exit(2)


def diff_user(user):
    """Devuelve dict {field: (current, target)} de los fields que cambian."""
    changes = {}
    for field, target in USER_DEFAULTS.items():
        current = user.get(field)
        if (current or "") != target:
            changes[field] = (current or "", target)
    return changes


def main():
    execute = "--execute" in sys.argv
    validate_env()

    print(f"Site:        {SITE}")
    print(f"Mode:        {'EXECUTE' if execute else 'DRY-RUN'}")
    print(f"Defaults:    {USER_DEFAULTS}")
    print()

    users = get_users()
    print(f"Enabled users (excluyendo {sorted(SKIP_USERS)}): {len(users)}")

    to_change = [(u, diff_user(u)) for u in users]
    to_change = [(u, d) for u, d in to_change if d]
    print(f"  - to update:  {len(to_change)}")
    print(f"  - already OK: {len(users) - len(to_change)}")
    print()

    print("Property Setter (default para users nuevos):")
    for field, value in PROPERTY_DEFAULTS.items():
        ps = get_property_setter(field)
        curr = ps.get("value") if ps else "(no existe)"
        marker = "OK" if curr == value else "would-change"
        print(f"  User.{field}.default: {curr!r:20s} -> {value!r}  [{marker}]")
    print()

    if not execute:
        print("Sample (max 10) cambios que se aplicarían:")
        for u, d in to_change[:10]:
            for field, (cur, tgt) in d.items():
                print(f"  {u['name']:45s} {field:18s}: {cur!r:20s} -> {tgt!r}")
        if len(to_change) > 10:
            print(f"  ... ({len(to_change) - 10} users más)")
        print()
        print("(dry-run — no changes applied; pass --execute para aplicar)")
        return

    user_ok = user_err = 0
    for i, (u, changes) in enumerate(to_change, 1):
        for field, (_, target) in changes.items():
            code, resp = set_user_field(u["name"], field, target)
            if code in (200, 201):
                user_ok += 1
            else:
                user_err += 1
                print(f"  ERR {u['name']}.{field}: code={code} resp={json.dumps(resp)[:120]}")
        if i % 10 == 0 or i == len(to_change):
            print(f"  progress users: {i}/{len(to_change)}")

    print(f"\nUser updates: ok={user_ok} err={user_err}")

    print("\nUpsert Property Setters ...")
    for field, value in PROPERTY_DEFAULTS.items():
        status = upsert_property_setter(field, value)
        print(f"  {field}.default = {value!r}: {status}")

    print("\nDone. Cada usuario debe hacer logout/login para ver los cambios.")


if __name__ == "__main__":
    main()
