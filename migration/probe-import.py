#!/usr/bin/env python3
"""
Probe: intenta insertar la muestra (1000+1000) en Frappe usando el translator
actual de import-from-csv.py y recolecta TODOS los errores sin parchar.

Output:
  /tmp/probe/results.jsonl  — un JSON por intento (request + response)
  /tmp/probe/summary.md     — métricas agregadas

Categorías de error:
  ok                       — insertado
  duplicate                — ya existe (DuplicateEntry, mostly RUT collision)
  validation               — ValidationError (incluye select inválido, etc.)
  mandatory                — MandatoryError
  link                     — LinkValidationError (FK rota)
  unknown_field            — fieldname no existe en doctype
  failed_main_contact      — deal: main_contact_id no resoluble
  network                  — timeout/conn
  other                    — sin clasificar

NO crea custom fields, NO repara, NO reintenta lógicamente — solo recolecta.
Sí usa retries de red para 5xx (heredados de http()).
"""

import csv
import json
import os
import re
import sys
import time
from collections import Counter

# Reuse translator + http from sibling module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "import_from_csv",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "import-from-csv.py"),
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

translate_contact_csv = m.translate_contact_csv
translate_deal_csv = m.translate_deal_csv
http = m.http
clean = m.clean
SITE = m.SITE
KEY = m.KEY
SECRET = m.SECRET

csv.field_size_limit(sys.maxsize)

CONTACTS_CSV = "/tmp/sample/contacts_1000.csv"
DEALS_CSV = "/tmp/sample/deals_1000.csv"
OUT_DIR = "/tmp/probe"
RESULTS_PATH = f"{OUT_DIR}/results.jsonl"
SUMMARY_PATH = f"{OUT_DIR}/summary.md"


def classify(code, resp_obj):
    """Inspect Frappe error response and return category + extracted message."""
    raw = json.dumps(resp_obj) if isinstance(resp_obj, dict) else str(resp_obj)

    if code in (200, 201):
        return "ok", ""

    if code == 599:
        return "network", raw[:200]

    # Try to pull the nice message
    msg = ""
    if isinstance(resp_obj, dict):
        msg = resp_obj.get("exception") or resp_obj.get("_server_messages") or resp_obj.get("_raw") or ""
        if isinstance(msg, str) and msg.startswith("["):
            try:
                arr = json.loads(msg)
                if arr and isinstance(arr[0], str):
                    inner = json.loads(arr[0])
                    msg = inner.get("message", arr[0])
            except Exception:
                pass

    text = (raw + " " + str(msg)).lower()

    if "duplicateentry" in text or "already exists" in text:
        return "duplicate", str(msg)[:300]
    if "mandatoryerror" in text or "is mandatory" in text:
        return "mandatory", str(msg)[:300]
    if "linkvalidationerror" in text or "could not be found" in text:
        return "link", str(msg)[:300]
    if "could not find field" in text or "unknown field" in text or "no such fieldname" in text:
        return "unknown_field", str(msg)[:300]
    if "validationerror" in text or "not a valid" in text or "invalid" in text:
        return "validation", str(msg)[:300]
    return "other", str(msg)[:300]


FIELD_RE = re.compile(r"<b>([^<]+)</b>", re.IGNORECASE)


def extract_field(msg):
    """Try to extract field name from Frappe error message."""
    if not msg:
        return None
    m1 = FIELD_RE.search(msg)
    if m1:
        return m1.group(1).strip()
    m2 = re.search(r"field[\"' ]+([a-z_]+)", msg, re.IGNORECASE)
    if m2:
        return m2.group(1)
    return None


def probe_entity(entity, csv_path, translator, results_fh, stats, contact_id_to_frappe_name=None):
    print(f"\n=== Probing {entity} from {csv_path} ===")
    started = time.time()
    n = 0
    with open(csv_path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            n += 1
            zendesk_id = clean(row.get("id"))
            try:
                doc = translator(row)
            except Exception as e:
                rec = {
                    "entity": entity, "row": n, "zendesk_id": zendesk_id,
                    "category": "translate_err", "msg": f"{type(e).__name__}: {e}",
                    "code": 0, "doc_keys": [], "resp": None,
                }
                results_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                stats[entity]["translate_err"] += 1
                continue

            # For deals, pre-check that main_contact_id resolves to a known Frappe Contact
            if entity == "deals":
                mcid = clean(row.get("main_contact_id"))
                if not mcid:
                    rec = {
                        "entity": entity, "row": n, "zendesk_id": zendesk_id,
                        "category": "failed_main_contact", "msg": "main_contact_id empty",
                        "code": 0, "doc_keys": list(doc.keys()), "resp": None,
                    }
                    results_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    stats[entity]["failed_main_contact"] += 1
                    continue
                if contact_id_to_frappe_name is not None and mcid not in contact_id_to_frappe_name:
                    rec = {
                        "entity": entity, "row": n, "zendesk_id": zendesk_id,
                        "category": "failed_main_contact",
                        "msg": f"main_contact_id {mcid} not in inserted contact set",
                        "code": 0, "doc_keys": list(doc.keys()), "resp": None,
                    }
                    results_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    stats[entity]["failed_main_contact"] += 1
                    continue
                # Note: we do NOT auto-link deal.contact here. The probe is about
                # surfacing schema gaps in the doctype, not link wiring.

            code, resp = http("POST", "/api/method/frappe.client.insert", {"doc": doc})
            cat, msg = classify(code, resp)

            inserted_name = None
            if cat == "ok" and isinstance(resp, dict):
                inserted_name = (resp.get("message") or {}).get("name")
                if entity == "contacts" and zendesk_id and inserted_name and contact_id_to_frappe_name is not None:
                    contact_id_to_frappe_name[zendesk_id] = inserted_name

            field = extract_field(msg)
            rec = {
                "entity": entity, "row": n, "zendesk_id": zendesk_id,
                "category": cat, "code": code, "msg": msg[:400],
                "field_hint": field,
                "doc_keys": list(doc.keys()),
                "inserted_name": inserted_name,
            }
            results_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            stats[entity][cat] += 1

            if n % 100 == 0:
                el = time.time() - started
                print(f"  {n} rows in {el:.0f}s  stats={dict(stats[entity])}")

    print(f"  Done {entity}: {n} rows in {time.time()-started:.0f}s  final={dict(stats[entity])}")


def write_summary(stats, results_path, summary_path):
    # Re-read JSONL to extract top errors and unmapped fields
    by_msg = Counter()
    by_field = Counter()
    by_category_field = Counter()
    raw_csv_cols_seen = set()

    with open(results_path, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("category") in ("ok", "translate_err"):
                continue
            msg = rec.get("msg") or ""
            if msg:
                # collapse numbers/IDs
                key = re.sub(r"\d{3,}", "<N>", msg)[:160]
                by_msg[key] += 1
            field = rec.get("field_hint")
            if field:
                by_field[field] += 1
                by_category_field[(rec["category"], field)] += 1

    # Source CSV columns coverage
    for path in (CONTACTS_CSV, DEALS_CSV):
        with open(path, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            raw_csv_cols_seen.update(reader.fieldnames or [])

    mapped_cols = set(m.CONTACT_CSV_TO_FRAPPE.keys()) | set(m.DEAL_CSV_TO_FRAPPE.keys())
    unmapped = sorted(c for c in raw_csv_cols_seen if c not in mapped_cols and not c.startswith("_") and c not in {"id", "scope"})

    lines = []
    lines.append("# Probe Summary\n")
    lines.append(f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    lines.append(f"Site: {SITE}\n\n")

    lines.append("## Per-entity counts\n")
    for ent, c in stats.items():
        total = sum(c.values())
        lines.append(f"### {ent} (n={total})\n")
        for k, v in sorted(c.items(), key=lambda kv: -kv[1]):
            pct = 100 * v / total if total else 0
            lines.append(f"- `{k}`: {v} ({pct:.1f}%)\n")
        lines.append("\n")

    lines.append("## Top 20 error messages\n")
    for msg, count in by_msg.most_common(20):
        lines.append(f"- ({count}) `{msg}`\n")
    lines.append("\n")

    lines.append("## Top fields cited in errors\n")
    for field, count in by_field.most_common(30):
        lines.append(f"- `{field}`: {count}\n")
    lines.append("\n")

    lines.append("## Errors by (category, field)\n")
    for (cat, field), count in by_category_field.most_common(40):
        lines.append(f"- {cat} / `{field}`: {count}\n")
    lines.append("\n")

    lines.append(f"## Unmapped source CSV columns ({len(unmapped)})\n")
    lines.append("Columns present in source CSVs but NOT in CONTACT_CSV_TO_FRAPPE / DEAL_CSV_TO_FRAPPE:\n\n")
    for c in unmapped:
        lines.append(f"- `{c}`\n")

    with open(summary_path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"Wrote {summary_path}")


def main():
    if not (SITE and KEY and SECRET):
        sys.exit("FRAPPE_CLOUD_* env vars not set")

    os.makedirs(OUT_DIR, exist_ok=True)

    stats = {
        "contacts": Counter(),
        "deals": Counter(),
    }
    contact_id_to_frappe_name = {}  # zendesk contact id → frappe name

    with open(RESULTS_PATH, "w", encoding="utf-8") as fh:
        probe_entity("contacts", CONTACTS_CSV, translate_contact_csv, fh, stats,
                     contact_id_to_frappe_name)
        probe_entity("deals", DEALS_CSV, translate_deal_csv, fh, stats,
                     contact_id_to_frappe_name)

    write_summary(stats, RESULTS_PATH, SUMMARY_PATH)
    print(f"\nResults: {RESULTS_PATH}")
    print(f"Summary: {SUMMARY_PATH}")


if __name__ == "__main__":
    main()
