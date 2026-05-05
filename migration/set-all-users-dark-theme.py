#!/usr/bin/env python3
"""
Setea `desk_theme = "Dark"` para TODOS los usuarios habilitados (System User
+ Website User) del site Frappe, e inserta un Property Setter para que los
usuarios nuevos también arranquen en Dark por default.

Idempotente:
  - skip users que ya tienen desk_theme = "Dark"
  - si el Property Setter ya existe con value=Dark, no lo recrea

Read-only sin --execute.

Env requeridas:
  FRAPPE_CLOUD_SITE_URL    https://crm-yqh-dgj.m.frappe.cloud
  FRAPPE_CLOUD_API_KEY     per-user API key
  FRAPPE_CLOUD_API_SECRET  per-user API secret

Usage:
  python3 migration/set-all-users-dark-theme.py            # dry-run
  python3 migration/set-all-users-dark-theme.py --execute  # aplica

Notas:
  - Frappe v15+ usa `User.desk_theme` para tematizar tanto el desk `/app/`
    como el FCRM frontend `/crm/`. Un solo cambio cubre ambas surfaces.
  - Cada usuario sigue pudiendo cambiar su tema desde su perfil (My Settings
    → Theme). Esto solo setea el default — no lo bloquea.
  - El Administrator y los users sin email válido se incluyen igual.
"""
import os, sys, json, time, urllib.request, urllib.error, urllib.parse

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

TARGET_THEME = "Dark"


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
    qs = urllib.parse.urlencode({
        "fields": '["name","desk_theme","user_type","enabled"]',
        "filters": '[["enabled","=",1]]',
        "limit_page_length": 0,
    })
    code, resp = http("GET", f"/api/resource/User?{qs}")
    if code != 200:
        print(f"ERROR listando users: code={code} resp={json.dumps(resp)[:200]}")
        sys.exit(1)
    return resp.get("data") or []


def set_user_theme(name, theme):
    return http(
        "POST",
        "/api/method/frappe.client.set_value",
        {"doctype": "User", "name": name, "fieldname": "desk_theme", "value": theme},
    )


def get_property_setter():
    qs = urllib.parse.urlencode({
        "fields": '["name","value"]',
        "filters": '[["doc_type","=","User"],["field_name","=","desk_theme"],["property","=","default"]]',
        "limit_page_length": 0,
    })
    code, resp = http("GET", f"/api/resource/Property Setter?{qs}")
    if code != 200:
        return None
    items = resp.get("data") or []
    return items[0] if items else None


def upsert_property_setter(theme):
    existing = get_property_setter()
    if existing:
        if existing.get("value") == theme:
            return "EXISTS_OK"
        code, resp = http(
            "POST",
            "/api/method/frappe.client.set_value",
            {
                "doctype": "Property Setter",
                "name": existing["name"],
                "fieldname": "value",
                "value": theme,
            },
        )
        return "OK_UPDATE" if code in (200, 201) else f"ERR_UPDATE: {json.dumps(resp)[:200]}"
    doc = {
        "doctype": "Property Setter",
        "doctype_or_field": "DocField",
        "doc_type": "User",
        "field_name": "desk_theme",
        "property": "default",
        "value": theme,
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


def main():
    execute = "--execute" in sys.argv
    validate_env()

    print(f"Site:        {SITE}")
    print(f"Theme:       {TARGET_THEME}")
    print(f"Mode:        {'EXECUTE' if execute else 'DRY-RUN'}")
    print()

    users = get_users()
    print(f"Enabled users: {len(users)}")

    needs_change = [u for u in users if (u.get("desk_theme") or "Light") != TARGET_THEME]
    already_ok = [u for u in users if (u.get("desk_theme") or "Light") == TARGET_THEME]

    print(f"  - already {TARGET_THEME}: {len(already_ok)}")
    print(f"  - to change:           {len(needs_change)}")
    print()

    existing_ps = get_property_setter()
    print(f"Property Setter User.desk_theme.default:")
    if existing_ps:
        print(f"  current value: {existing_ps.get('value')!r}")
    else:
        print(f"  (no existe — se creará con value={TARGET_THEME!r})")
    print()

    if not execute:
        print("Sample (max 20) usuarios que cambiarían:")
        for u in needs_change[:20]:
            curr = u.get("desk_theme") or "Light"
            print(f"  {u['name']:50s} {curr:10s} -> {TARGET_THEME}")
        if len(needs_change) > 20:
            print(f"  ... ({len(needs_change) - 20} más)")
        print()
        print("(dry-run — no changes applied; pass --execute para aplicar)")
        return

    ok = err = 0
    for i, u in enumerate(needs_change, 1):
        code, resp = set_user_theme(u["name"], TARGET_THEME)
        if code in (200, 201):
            ok += 1
        else:
            err += 1
            print(f"  ERR {u['name']}: code={code} resp={json.dumps(resp)[:120]}")
        if i % 10 == 0 or i == len(needs_change):
            print(f"  progress: {i}/{len(needs_change)} (ok={ok} err={err})")

    print(f"\nUsers final: ok={ok} err={err}")

    print("\nUpsert Property Setter User.desk_theme.default ...")
    status = upsert_property_setter(TARGET_THEME)
    print(f"  status: {status}")

    print("\nDone. Cada usuario sigue pudiendo override desde 'My Settings' → Theme.")


if __name__ == "__main__":
    main()
