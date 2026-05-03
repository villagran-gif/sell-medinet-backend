#!/usr/bin/env python3
"""
Fase 2 - Schema setup. Idempotente.

  1. Crea Frappe Users por cada owner único (23) con email construido.
  2. Crea CRM Deal Pipeline (4) y CRM Deal Status (16) — TAL CUAL del source.
  3. Crea Tag (22).
  4. Crea Custom Fields raw mirror (zd_<col_snake>) en Contact, CRM Deal,
     CRM Lead — todos como Long Text. Plus canonical IDs.
  5. Cambia Contact.autoname (manual TODO — Frappe lo resiste vía API
     en doctypes "core"; deja log de instrucciones).

Lee /tmp/migration/discovery.json (creado por discovery.py).

Env: FRAPPE_CLOUD_SITE_URL, FRAPPE_CLOUD_API_KEY, FRAPPE_CLOUD_API_SECRET
"""
import os, sys, json, time, re, urllib.request, urllib.error, urllib.parse

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

DISCOVERY = "/tmp/migration/discovery.json"
EMAIL_DOMAIN = "clinyco.cl"


def http(method, path, body=None, timeout=30, retries=3):
    data = json.dumps(body).encode() if body else None
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
            headers={"Authorization": AUTH, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", errors="replace")
            if e.code >= 500 and attempt < retries - 1:
                time.sleep(2 ** attempt); continue
            try: return e.code, json.loads(text)
            except: return e.code, {"_raw": text[:300]}
        except (TimeoutError, urllib.error.URLError, ConnectionError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt); continue
            return 599, {"_raw": str(e)}
    return 599, {"_raw": str(last)}


def insert(doc):
    code, resp = http("POST", "/api/method/frappe.client.insert", {"doc": doc})
    if code in (200, 201):
        return "OK", (resp.get("message") or {}).get("name")
    body = json.dumps(resp).lower()
    if "duplicateentry" in body or "already exists" in body:
        return "EXISTS", None
    return "ERR", json.dumps(resp)[:200]


def snake(s):
    """Normaliza un nombre de columna source → snake_case ASCII para fieldname."""
    s = s.strip()
    repl = {"á":"a","é":"e","í":"i","ó":"o","ú":"u","ñ":"n",
            "Á":"a","É":"e","Í":"i","Ó":"o","Ú":"u","Ñ":"n",
            " ":"_", "/":"_", ".":"_", "(":"", ")":"", "#":"", "*":"",
            "\\":"_", ":":"_", "-":"_", "+":"_", ",":"_", "'":"", "\"":"",
            "?":"", "¿":"", "!":"", "¡":"", "&":"_and_"}
    for k, v in repl.items(): s = s.replace(k, v)
    s = re.sub(r"[^a-zA-Z0-9_]", "", s)
    s = re.sub(r"_+", "_", s).strip("_").lower()
    return s


def email_from_name(name):
    """'Dr. Villagran - Dr. Eluzen' → 'dr.villagran-dr.eluzen@clinyco.cl'."""
    n = name.replace(" - Deleted", "").strip()
    n = n.lower()
    n = re.sub(r"\s+", ".", n)
    n = re.sub(r"[^a-z0-9._-]", "", n)
    n = re.sub(r"\.+", ".", n).strip(".")
    if not n: n = "user"
    return f"{n}@{EMAIL_DOMAIN}"


# ─────────────────────────────────────────────────────────────────────────────
# Entity setups
# ─────────────────────────────────────────────────────────────────────────────

def setup_users(discovery):
    print("\n=== Users ===")
    stats = {"OK": 0, "EXISTS": 0, "ERR": 0}
    user_email_by_name = {}
    for u in discovery["users"]:
        name = u["name"]
        is_deleted = "- Deleted" in name
        email = email_from_name(name)
        user_email_by_name[name] = email
        first = name.split()[0]
        last = " ".join(name.split()[1:]).replace("- Deleted", "").strip() or "—"
        doc = {
            "doctype": "User",
            "email": email,
            "first_name": first,
            "last_name": last,
            "enabled": 0 if is_deleted else 1,
            "send_welcome_email": 0,
            "user_type": "System User",
        }
        s, info = insert(doc)
        stats[s] = stats.get(s, 0) + 1
        if s == "ERR":
            print(f"  ERR {email}: {info}")
    print(f"  Users: {stats}")
    return user_email_by_name


def setup_pipelines_stages(discovery):
    print("\n=== Pipelines + Stages ===")
    stats_p = {"OK": 0, "EXISTS": 0, "ERR": 0}
    stats_s = {"OK": 0, "EXISTS": 0, "ERR": 0}

    # Stages first (CRM Deal Status), each with their owning pipeline noted in description
    stages_seen = set()
    for pname, slist in discovery["pipelines"].items():
        for s in slist:
            if s in stages_seen: continue
            stages_seen.add(s)
            doc = {"doctype": "CRM Deal Status", "name": s, "color": "gray"}
            st, info = insert(doc)
            stats_s[st] = stats_s.get(st, 0) + 1
            if st == "ERR":
                print(f"  ERR stage {s}: {info}")
    print(f"  Stages (CRM Deal Status): {stats_s}")

    # Pipelines (CRM Deal Pipeline) — one row per pipeline
    for pname in discovery["pipelines"]:
        doc = {"doctype": "CRM Deal Pipeline", "pipeline_name": pname}
        st, info = insert(doc)
        stats_p[st] = stats_p.get(st, 0) + 1
        if st == "ERR":
            print(f"  ERR pipeline {pname}: {info}")
    print(f"  Pipelines: {stats_p}")


def setup_tags(discovery):
    print("\n=== Tags ===")
    stats = {"OK": 0, "EXISTS": 0, "ERR": 0}
    for t in discovery["tags"]:
        doc = {"doctype": "Tag", "name": t["name"]}
        s, info = insert(doc)
        stats[s] = stats.get(s, 0) + 1
        if s == "ERR":
            print(f"  ERR tag {t['name']}: {info}")
    print(f"  Tags: {stats}")


def setup_custom_fields(discovery):
    print("\n=== Custom Fields (raw mirror zd_*) ===")

    # Plus canonical IDs per doctype
    canonicals = {
        "Contact": [("zendesk_id_contact", "Data", "Zendesk Contact ID", 1)],
        "CRM Deal": [
            ("zendesk_id_deal", "Data", "Zendesk Deal ID", 1),
            ("zendesk_id_main_contact", "Data", "Zendesk Main Contact ID", 1),
        ],
        "CRM Lead": [("zendesk_id_lead", "Data", "Zendesk Lead ID", 1)],
        "Comment": [("zendesk_id_note", "Data", "Zendesk Note ID", 1)],
        "CRM Task": [("zendesk_id_task", "Data", "Zendesk Task ID", 1)],
    }

    entity_to_doctype = {
        "contacts": "Contact",
        "deals": "CRM Deal",
        "leads": "CRM Lead",
        "notes": "Comment",
        "tasks": "CRM Task",
    }

    grand = {"OK": 0, "EXISTS": 0, "ERR": 0}

    for ent, dt in entity_to_doctype.items():
        cols = discovery["entities"][ent]["cols"]
        nonempty = discovery["entities"][ent]["nonempty_per_col"]
        print(f"\n  -- {dt} ({len(cols)} source cols) --")

        # Raw mirror: one Long Text per source column
        seen = set()
        per_dt = {"OK": 0, "EXISTS": 0, "ERR": 0}
        for col in cols:
            base = snake(col)
            if not base: continue
            fname = f"zd_{base}"[:64]  # Frappe limits fieldname length
            if fname in seen: continue
            seen.add(fname)
            doc = {
                "doctype": "Custom Field",
                "dt": dt,
                "fieldname": fname,
                "fieldtype": "Long Text",
                "label": col[:140],
                "description": f"Source column '{col}'. Non-empty in source: {nonempty.get(col, 0)}",
                "no_copy": 1,
            }
            s, info = insert(doc)
            per_dt[s] = per_dt.get(s, 0) + 1
            grand[s] = grand.get(s, 0) + 1
            if s == "ERR":
                print(f"    ERR {fname}: {info}")

        # Canonicals
        for fname, ftype, label, indexed in canonicals.get(dt, []):
            doc = {
                "doctype": "Custom Field",
                "dt": dt,
                "fieldname": fname,
                "fieldtype": ftype,
                "label": label,
                "in_standard_filter": 1,
                "search_index": indexed,
                "no_copy": 1,
            }
            s, info = insert(doc)
            per_dt[s] = per_dt.get(s, 0) + 1
            grand[s] = grand.get(s, 0) + 1
            if s == "ERR":
                print(f"    ERR canonical {fname}: {info}")

        print(f"    {per_dt}")

    print(f"\n  TOTAL custom fields: {grand}")


def main():
    if not (SITE and KEY and SECRET):
        sys.exit("FRAPPE_CLOUD_* no seteadas")
    if not os.path.exists(DISCOVERY):
        sys.exit(f"Falta {DISCOVERY}. Corré discovery.py primero.")

    discovery = json.load(open(DISCOVERY, encoding="utf-8"))
    print(f"Site: {SITE}")
    print(f"Discovery: {sum(e['rows'] for e in discovery['entities'].values())} rows total")

    setup_users(discovery)
    setup_pipelines_stages(discovery)
    setup_tags(discovery)
    setup_custom_fields(discovery)

    print("\n=== TODO manual ===")
    print("  Cambiar Contact.autoname a 'field:rut_normalizado' desde el desk:")
    print("    /app/doctype/Contact → Naming → autoname = 'field:rut_normalizado'")
    print("  (Frappe restringe API edits sobre doctypes core. Se hace en la UI.)")


if __name__ == "__main__":
    main()
