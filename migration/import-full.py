#!/usr/bin/env python3
"""
Fases 3-7: import full (raw mirror) de contacts, deals, leads, notes, tasks.

  python3 migration/import-full.py --entity contacts
  python3 migration/import-full.py --entity deals
  python3 migration/import-full.py --entity leads
  python3 migration/import-full.py --entity notes
  python3 migration/import-full.py --entity tasks

Modo:
  --workers 8     hilos paralelos (default 8)
  --limit N       primeros N rows (testing)
  --dry-run       no inserta, solo print

Idempotente: si existe `zendesk_id_<ent>` con valor X, hace UPDATE en vez de INSERT.

Genera/usa /tmp/migration/contact_id_map.json y deal_id_map.json para
linkear deals.contact y notes/tasks reference_name.
"""
import argparse, csv, json, os, re, sys, time, urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter

csv.field_size_limit(sys.maxsize)

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

SOURCE_DIR = "/tmp/zendesk-export-new"
MAP_DIR = "/tmp/migration"

ENTITY_CONFIG = {
    "contacts": {
        "csv": "contacts.0.csv",
        "doctype": "Contact",
        "id_field": "zendesk_id_contact",
        "source_id": "id",
        "map_out": "contact_id_map.json",
    },
    "deals": {
        "csv": "deals.0.csv",
        "doctype": "CRM Deal",
        "id_field": "zendesk_id_deal",
        "source_id": "id",
        "map_out": "deal_id_map.json",
    },
    "leads": {
        "csv": "leads.0.csv",
        "doctype": "CRM Lead",
        "id_field": "zendesk_id_lead",
        "source_id": "id",
        "map_out": "lead_id_map.json",
    },
    "notes": {
        "csv": "notes.0.csv",
        "doctype": "FCRM Note",
        "id_field": "zendesk_id_note",
        "source_id": "id",
    },
    "tasks": {
        "csv": "tasks.0.csv",
        "doctype": "CRM Task",
        "id_field": "zendesk_id_task",
        "source_id": "id",
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────────────────────────────────────

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


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

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


def normalize_rut(v):
    if not v: return None
    s = re.sub(r"[^0-9Kk]", "", str(v)).upper()
    return s if 7 <= len(s) <= 10 else None


def _email_for_owner(name):
    """Replica de schema-setup.email_from_name. Returns email used to create User."""
    n = name.replace(" - Deleted", "").strip().lower()
    n = re.sub(r"\s+", ".", n)
    n = re.sub(r"[^a-z0-9._-]", "", n)
    n = re.sub(r"\.+", ".", n).strip(".")
    return f"{n or 'user'}@clinyco.cl"


def load_map(name):
    p = f"{MAP_DIR}/{name}"
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))
    return {}


def save_map(name, m):
    os.makedirs(MAP_DIR, exist_ok=True)
    with open(f"{MAP_DIR}/{name}", "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)


# ─────────────────────────────────────────────────────────────────────────────
# Translators
# ─────────────────────────────────────────────────────────────────────────────

def translate_generic(row, doctype, id_field, source_id_col, contact_map=None):
    """Raw mirror: every source col → zd_<snake>. Plus canonicals + special links."""
    doc = {"doctype": doctype}
    seen_field = set()

    for col, v in row.items():
        if v is None: continue
        v = str(v).strip()
        if not v: continue
        base = snake(col)
        if not base: continue
        fname = f"zd_{base}"[:64]
        if fname in seen_field: continue  # first non-empty wins on collisions
        seen_field.add(fname)
        doc[fname] = v

    # Canonical zendesk_id
    src_id = (row.get(source_id_col) or "").strip()
    if src_id:
        doc[id_field] = src_id

    # Per-doctype specials
    if doctype == "Contact":
        rut = normalize_rut(row.get("custom (contact) RUT o ID") or row.get("custom (contact) RUT_normalizado"))
        if rut: doc["rut_normalizado"] = rut
        first = (row.get("first_name") or "").strip()
        last = (row.get("last_name") or "").strip()
        if first: doc["first_name"] = first
        if last: doc["last_name"] = last
        # email/phone se preservan en zd_email, zd_phone, zd_mobile (raw).
        # No los seteamos en email_ids/phone_nos porque Frappe valida estricto
        # (rechaza formatos chilenos válidos como '+56953908228'). Cleanup
        # posterior puede poblar las child tables filtrando los válidos.

    elif doctype == "CRM Deal":
        rut = normalize_rut(row.get("custom RUT o ID") or row.get("custom RUT O ID")
                             or row.get("custom RUT_normalizado"))
        if rut: doc["rut_normalizado"] = rut
        # Pipeline (custom) + status (link to CRM Deal Status)
        pn = (row.get("pipeline_name") or "").strip()
        sn = (row.get("stage_name") or "").strip()
        if pn: doc["pipeline_name"] = pn
        if sn: doc["status"] = sn
        # Main contact link via map
        mcid = (row.get("main_contact_id") or "").strip()
        if mcid:
            doc["zendesk_id_main_contact"] = mcid
            if contact_map and mcid in contact_map:
                doc["contact"] = contact_map[mcid]
        # Deal name (lead_name native)
        nm = (row.get("name") or "").strip()
        if nm: doc["lead_name"] = nm[:140]
        # Owner → User
        owner = (row.get("owner") or "").strip()
        if owner: doc["deal_owner"] = _email_for_owner(owner)
        # Currency
        cur = (row.get("currency") or "").strip()
        if cur: doc["currency"] = cur
        # Loss reason: Frappe requires it para deals Lost (SUSPENDIDO/SIN RESPUESTA/DESCALIFICADO)
        lr = (row.get("loss_reason") or "").strip()
        sn_up = sn.upper()
        if lr:
            doc["lost_reason"] = lr
        elif sn_up in ("SUSPENDIDO", "SIN RESPUESTA", "DESCALIFICADO"):
            doc["lost_reason"] = "Sin información"

    elif doctype == "CRM Lead":
        first = (row.get("first_name") or "").strip()
        last = (row.get("last_name") or "").strip()
        if first: doc["first_name"] = first
        if last: doc["last_name"] = last
        em = (row.get("email") or "").strip()
        if em and "@" in em: doc["email"] = em
        org = (row.get("company_name") or "").strip()
        if org: doc["organization"] = org

    elif doctype == "FCRM Note":
        # FCRM Note uses reference_doctype + reference_docname (Dynamic Link)
        rt = (row.get("noteable_type") or "").strip()
        rid = (row.get("noteable_id") or "").strip()
        if rt and rid:
            doc["zendesk_noteable_type"] = rt
            doc["zendesk_noteable_id"] = rid
        content = (row.get("content") or "").strip()
        if content: doc["content"] = content
        doc["title"] = (content[:80] + "...") if len(content) > 80 else (content or "Note")

    elif doctype == "CRM Task":
        title = (row.get("content") or "").strip()
        if title: doc["title"] = title[:140]
        else: doc["title"] = "Task"
        date = (row.get("date") or "").strip()
        if date: doc["due_date"] = date.replace("T", " ").split(".")[0][:19]
        done = (row.get("done_at") or "").strip()
        doc["status"] = "Done" if done else "Backlog"
        owner = (row.get("owner") or "").strip()
        if owner: doc["assigned_to"] = _email_for_owner(owner)
        rt = (row.get("taskable_type") or "").strip()
        rid = (row.get("taskable_id") or "").strip()
        if rt and rid:
            doc["zendesk_taskable_type"] = rt
            doc["zendesk_taskable_id"] = rid

    return doc


# ─────────────────────────────────────────────────────────────────────────────
# Insert / Update with idempotency
# ─────────────────────────────────────────────────────────────────────────────

def find_existing(doctype, id_field, value):
    if not value: return None
    filters = json.dumps([[id_field, "=", str(value)]])
    code, data = http("GET",
        f"/api/method/frappe.client.get_list?doctype={urllib.parse.quote(doctype)}"
        f"&filters={urllib.parse.quote(filters)}"
        f"&fields={urllib.parse.quote(json.dumps(['name']))}&limit_page_length=1")
    if code == 200 and data.get("message"):
        return data["message"][0]["name"]
    return None


def upsert(doctype, id_field, doc):
    src_id = doc.get(id_field)
    existing = find_existing(doctype, id_field, src_id) if src_id else None
    if existing:
        # PATCH all fields
        body = {k: v for k, v in doc.items() if k != "doctype"}
        c, r = http("PUT", f"/api/resource/{urllib.parse.quote(doctype)}/{urllib.parse.quote(existing, safe='')}", body)
        if c in (200, 202): return "UPD", existing
        return "ERR", json.dumps(r)[:200]
    c, r = http("POST", "/api/method/frappe.client.insert", {"doc": doc})
    if c in (200, 201):
        return "INS", (r.get("message") or {}).get("name")
    body = json.dumps(r).lower()
    if "duplicateentry" in body or "already exists" in body:
        return "DUP", json.dumps(r)[:200]
    return "ERR", json.dumps(r)[:200]


# ─────────────────────────────────────────────────────────────────────────────
# Per-entity runners
# ─────────────────────────────────────────────────────────────────────────────

def run(entity, args):
    cfg = ENTITY_CONFIG[entity]
    csv_path = f"{SOURCE_DIR}/{cfg['csv']}"
    doctype = cfg["doctype"]
    id_field = cfg["id_field"]
    source_id_col = cfg["source_id"]

    contact_map = load_map("contact_id_map.json") if entity in ("deals", "notes", "tasks") else None
    deal_map = load_map("deal_id_map.json") if entity in ("notes", "tasks") else None
    lead_map = load_map("lead_id_map.json") if entity in ("notes", "tasks") else None

    # For notes/tasks: pre-build reference resolver
    def resolve_ref(rt, rid):
        if not (rt and rid): return None, None
        if rt == "Contact" and rid in (contact_map or {}):
            return "Contact", contact_map[rid]
        if rt == "Deal" and rid in (deal_map or {}):
            return "CRM Deal", deal_map[rid]
        if rt == "Lead" and rid in (lead_map or {}):
            return "CRM Lead", lead_map[rid]
        return None, None

    out_map = {}  # source_id → frappe name (only for entities that have map_out)

    print(f"=== Import {entity} → {doctype} ===")
    print(f"  CSV: {csv_path}")

    with open(csv_path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if args.limit: rows = rows[:args.limit]
    print(f"  rows: {len(rows)}")

    stats = Counter()
    started = time.time()

    def process(idx, row):
        try:
            doc = translate_generic(row, doctype, id_field, source_id_col, contact_map)
            # Notes need reference resolution (FCRM Note uses reference_docname)
            if doctype == "FCRM Note":
                rt = (row.get("noteable_type") or "").strip()
                rid = (row.get("noteable_id") or "").strip()
                ref_dt, ref_name = resolve_ref(rt, rid)
                if ref_dt and ref_name:
                    doc["reference_doctype"] = ref_dt
                    doc["reference_docname"] = ref_name
                # else: insert anyway, with zd_noteable_* preserved for later resolution

            # Tasks: optional taskable resolution
            if doctype == "CRM Task":
                rt = (row.get("taskable_type") or "").strip()
                rid = (row.get("taskable_id") or "").strip()
                ref_dt, ref_name = resolve_ref(rt, rid)
                if ref_dt and ref_name:
                    doc["reference_doctype"] = ref_dt
                    doc["reference_docname"] = ref_name
            # Tasks need taskable resolution to assignee link (skip if no resolution)
            if args.dry_run:
                return idx, "DRY", row.get("id"), None
            s, info = upsert(doctype, id_field, doc)
            return idx, s, doc.get(id_field), info if s in ("INS", "UPD") else info
        except Exception as e:
            return idx, "EXC", row.get("id"), f"{type(e).__name__}: {e}"

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(process, i, r) for i, r in enumerate(rows)]
        for done, f in enumerate(as_completed(futures), 1):
            idx, status, src_id, info = f.result()
            stats[status] += 1
            if status in ("INS", "UPD") and src_id and info:
                out_map[src_id] = info
            if status in ("ERR", "EXC") and stats[status] <= 5:
                print(f"  [{status}] src_id={src_id}: {info}")
            if done % 500 == 0:
                el = time.time() - started
                print(f"  --- {done}/{len(rows)} in {el:.0f}s  stats={dict(stats)}")

    print(f"\n=== Done {entity} in {time.time()-started:.0f}s ===")
    print(f"  stats: {dict(stats)}")

    if cfg.get("map_out") and out_map:
        save_map(cfg["map_out"], out_map)
        print(f"  Saved {len(out_map)} entries to /tmp/migration/{cfg['map_out']}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--entity", required=True, choices=list(ENTITY_CONFIG.keys()))
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    if not (SITE and KEY and SECRET):
        sys.exit("FRAPPE_CLOUD_* no seteadas")
    run(args.entity, args)


if __name__ == "__main__":
    main()
