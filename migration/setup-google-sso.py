#!/usr/bin/env python3
"""
Configura Google SSO en Frappe CRM (`crm-yqh-dgj.m.frappe.cloud`) de forma
idempotente:

  1. Crea/actualiza el Social Login Key "Google" con el client_id/secret
     provistos via env vars.
  2. Lo deja `enable_social_login=1` para que aparezca el botón en /login.

NO toca:
  - System Settings (toggles de password login → editar manual via UI).
  - Website Theme custom CSS (override visual → manual).
  - Role Profile default (depende de qué roles existen → manual).

Read-only sin --execute. Idempotente.

Env requeridas:
  FRAPPE_CLOUD_SITE_URL    https://crm-yqh-dgj.m.frappe.cloud
  FRAPPE_CLOUD_API_KEY     per-user API key
  FRAPPE_CLOUD_API_SECRET  per-user API secret
  GOOGLE_OAUTH_CLIENT_ID   del OAuth Client en Google Cloud Console
  GOOGLE_OAUTH_CLIENT_SECRET

Usage:
  python3 migration/setup-google-sso.py            # dry-run
  python3 migration/setup-google-sso.py --execute  # aplica
"""
import os, sys, json, time, urllib.request, urllib.error

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

PROVIDER_NAME = "Google"


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


def get_existing():
    code, resp = http(
        "GET",
        f"/api/resource/Social Login Key?filters=%5B%5B%22provider_name%22%2C%22%3D%22%2C%22{PROVIDER_NAME}%22%5D%5D",
    )
    if code != 200:
        return None, (code, resp)
    items = resp.get("data") or []
    return (items[0]["name"] if items else None), None


def insert_doc(doc):
    return http("POST", "/api/method/frappe.client.insert", {"doc": doc})


def update_doc(name, values):
    return http(
        "POST",
        "/api/method/frappe.client.set_value",
        {"doctype": "Social Login Key", "name": name, "fieldname": values},
    )


def validate_env():
    missing = []
    for var in (
        "FRAPPE_CLOUD_SITE_URL",
        "FRAPPE_CLOUD_API_KEY",
        "FRAPPE_CLOUD_API_SECRET",
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
    ):
        if not os.environ.get(var):
            missing.append(var)
    if missing:
        print(f"ERROR: faltan env vars: {', '.join(missing)}")
        sys.exit(2)


def main():
    execute = "--execute" in sys.argv
    validate_env()

    print(f"Site:        {SITE}")
    print(f"Provider:    {PROVIDER_NAME}")
    print(f"Client ID:   {GOOGLE_CLIENT_ID[:12]}...{GOOGLE_CLIENT_ID[-4:]}")
    print(f"Mode:        {'EXECUTE' if execute else 'DRY-RUN'}")
    print()

    existing, err = get_existing()
    if err:
        print(f"ERROR consultando Social Login Key: code={err[0]} resp={err[1]}")
        sys.exit(1)

    desired_values = {
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "enable_social_login": 1,
        "sign_ups": "Allow",
    }

    if existing:
        print(f"Found existing Social Login Key: '{existing}'")
        print("Plan: actualizar client_id, client_secret, enable_social_login=1, sign_ups=Allow")
        if not execute:
            print("\n(dry-run — no changes applied; pass --execute para aplicar)")
            return
        code, resp = update_doc(existing, desired_values)
        if code in (200, 201):
            print("OK — Social Login Key actualizada.")
        else:
            print(f"ERR update — code={code} resp={resp}")
            sys.exit(1)
    else:
        doc = {
            "doctype": "Social Login Key",
            "provider_name": PROVIDER_NAME,
            "social_login_provider": "Google",
            **desired_values,
        }
        print("Plan: crear Social Login Key 'Google' (Frappe rellena URLs OAuth automáticamente)")
        print(json.dumps(
            {**doc, "client_secret": "***"}, indent=2, ensure_ascii=False,
        ))
        if not execute:
            print("\n(dry-run — no changes applied; pass --execute para aplicar)")
            return
        code, resp = insert_doc(doc)
        if code in (200, 201):
            name = (resp.get("message") or {}).get("name", "?")
            print(f"OK — Social Login Key creada: {name}")
        else:
            print(f"ERR insert — code={code} resp={resp}")
            sys.exit(1)

    print()
    print("Próximos pasos manuales (ver migration/auth-google-sso.md):")
    print("  - System Settings: deshabilitar password/user-name login (sec 5.1)")
    print("  - Website Settings: custom CSS para ocultar form user/pass (sec 5.2)")
    print("  - Role Profile default para JIT users (sec 6.1)")
    print("  - Probar login con Google logged out (sec 7)")


if __name__ == "__main__":
    main()
