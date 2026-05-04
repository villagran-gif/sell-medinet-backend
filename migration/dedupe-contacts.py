#!/usr/bin/env python3
"""
Dedupe Contact records en Frappe por rut_normalizado.

Estrategia:
- Por cada grupo de RUTs duplicados:
  1. Score cada contact por completitud (cantidad de fields populated)
  2. Keep el "más completo" (más fields → score más alto)
  3. Para los duplicados, copiar fields no-vacíos al "keeper" si éste no los tiene
  4. Delete los duplicados

Reglas:
- Solo procesa RUTs válidos (numéricos, 7-10 chars)
- No toca contactos sin rut_normalizado
- Idempotente: si no hay dups, no hace nada

Uso:
  python3 migration/dedupe-contacts.py --dry-run     # show what would happen
  python3 migration/dedupe-contacts.py               # actual dedupe

Env vars: FRAPPE_CLOUD_SITE_URL, FRAPPE_CLOUD_API_KEY, FRAPPE_CLOUD_API_SECRET
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error
import urllib.parse
import re
from collections import defaultdict, Counter

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

# Fields que cuentan para "completitud" del Contact
SCORED_FIELDS = [
    "first_name", "last_name", "email_id", "phone", "mobile_no",
    "rut", "rut_normalizado", "edad", "fecha_nacimiento",
    "peso_kg", "estatura_m", "imc", "tabaco",
    "prevision", "tramo_modalidad", "ciudad",
    "agente", "interes", "fecha_ingresa_formulario",
    "enfermedades_cronicas",
]


def http(method, path, body=None, timeout=20, retries=3):
    data = json.dumps(body).encode() if body else None
    for attempt in range(retries):
        req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
            headers={"Authorization": AUTH, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read())
            except json.JSONDecodeError:
                return e.code, {"_raw": "(non-json)"}
        except (TimeoutError, urllib.error.URLError) as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            return 599, {"_raw": str(e)}
    return 599, {"_raw": "exhausted"}


def get_contact(name):
    enc = urllib.parse.quote(name)
    code, data = http("GET", f"/api/resource/Contact/{enc}")
    if code == 200:
        return data.get("data", {})
    return None


def is_valid_rut(rut):
    if not rut:
        return False
    s = re.sub(r"[^0-9Kk]", "", str(rut).upper())
    return 7 <= len(s) <= 10 and re.match(r"^\d+[0-9K]$", s) is not None


def score_contact(c):
    """Más fields populated = score mayor."""
    score = 0
    for f in SCORED_FIELDS:
        v = c.get(f)
        if v not in (None, "", []):
            score += 1
    # Bonus: child tables populated
    if c.get("email_ids"):
        score += len(c["email_ids"])
    if c.get("phone_nos"):
        score += len(c["phone_nos"])
    return score


def merge_into_keeper(keeper, dup):
    """Copia fields del dup al keeper si keeper no los tiene. Returns updates dict."""
    updates = {}
    for f in SCORED_FIELDS:
        if (keeper.get(f) in (None, "", [])) and dup.get(f) not in (None, "", []):
            updates[f] = dup[f]
    return updates


def update_contact(name, updates):
    enc = urllib.parse.quote(name)
    code, data = http("PUT", f"/api/resource/Contact/{enc}", updates)
    return code in (200, 202)


def delete_contact(name):
    enc = urllib.parse.quote(name)
    code, _ = http("DELETE", f"/api/resource/Contact/{enc}")
    return code in (200, 202)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit-groups", type=int, default=0,
                   help="solo procesar primeros N grupos (0=all)")
    args = p.parse_args()

    if not (SITE and KEY and SECRET):
        sys.exit("FRAPPE_CLOUD_* env vars no seteadas")

    # Step 1: list all contacts with rut_normalizado
    print("=== Listando contacts con rut_normalizado ===")
    all_contacts = []
    page = 0
    fields = json.dumps(["name", "rut_normalizado"])
    while True:
        page += 1
        url = f"/api/method/frappe.client.get_list?doctype=Contact&fields={urllib.parse.quote(fields)}&limit_page_length=200&limit_start={(page-1)*200}"
        code, data = http("GET", url)
        msg = data.get("message", []) if code == 200 else []
        if not msg:
            break
        all_contacts.extend([c for c in msg if c.get("rut_normalizado")])
        if len(msg) < 200:
            break

    print(f"  Total con rut_normalizado: {len(all_contacts)}")

    # Step 2: group by rut, filter valid only
    groups = defaultdict(list)
    for c in all_contacts:
        rut = c["rut_normalizado"]
        if is_valid_rut(rut):
            groups[rut].append(c["name"])

    dup_groups = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"  RUTs duplicados (válidos): {len(dup_groups)} grupos, "
          f"{sum(len(v) for v in dup_groups.values())} contactos")

    if not dup_groups:
        print("  Nada que dedupear.")
        return

    if args.limit_groups:
        dup_groups = dict(list(dup_groups.items())[:args.limit_groups])
        print(f"  Limitando a primeros {args.limit_groups} grupos")

    # Step 3: dedupe each group
    stats = Counter()
    started = time.time()
    for i, (rut, names) in enumerate(dup_groups.items(), 1):
        # Fetch full docs to score
        docs = []
        for n in names:
            d = get_contact(n)
            if d:
                docs.append(d)
        if len(docs) < 2:
            stats["incomplete"] += 1
            continue

        # Sort by score descending
        docs.sort(key=score_contact, reverse=True)
        keeper = docs[0]
        dups = docs[1:]

        if args.dry_run:
            print(f"\n  [{i}/{len(dup_groups)}] RUT={rut}")
            print(f"    KEEP: {keeper['name']} (score={score_contact(keeper)})")
            for d in dups:
                print(f"    DELETE: {d['name']} (score={score_contact(d)})")
            continue

        # Merge non-empty fields from dups into keeper
        merged_updates = {}
        for d in dups:
            for k, v in merge_into_keeper(keeper, d).items():
                if k not in merged_updates:  # first dup with that field wins
                    merged_updates[k] = v
        if merged_updates:
            if update_contact(keeper["name"], merged_updates):
                stats["merged_into_keeper"] += 1
            else:
                stats["merge_err"] += 1

        # Delete dups
        for d in dups:
            if delete_contact(d["name"]):
                stats["deleted"] += 1
            else:
                stats["delete_err"] += 1

        if i % 50 == 0:
            elapsed = time.time() - started
            rate = i / elapsed if elapsed else 0
            print(f"  ... {i}/{len(dup_groups)} groups in {elapsed:.0f}s ({rate:.1f}/s)")

    print(f"\n=== Done ===")
    print(f"  Stats: {dict(stats)}")
    print(f"  Total time: {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
