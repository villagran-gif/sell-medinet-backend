#!/usr/bin/env python3
"""
Saca una muestra random reproducible de 1000 contacts + 1000 deals.

- Contacts: 1000 random rows del CSV.
- Deals: 1000 rows priorizando los que linkean a contacts en la muestra
  (main_contact_id ∈ sample_contact_ids); si no llegan a 1000, completa con
  random extra (esos quedan como "huérfanos" — su main_contact_id no estará
  en la muestra de contacts; el probe los marcará como tal).

Output: /tmp/sample/contacts_1000.csv y /tmp/sample/deals_1000.csv
"""

import csv
import os
import random
import sys

csv.field_size_limit(sys.maxsize)

CONTACTS_SRC = "/tmp/zendesk-export-new/contacts.0.csv"
DEALS_SRC = "/tmp/zendesk-export-new/deals.0.csv"
OUT_DIR = "/tmp/sample"
N_CONTACTS = 1000
N_DEALS = 1000
SEED = 42


def load_rows(path):
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)
    return fieldnames, rows


def write_rows(path, fieldnames, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def main():
    random.seed(SEED)

    print(f"Loading {CONTACTS_SRC}...")
    c_fields, c_rows = load_rows(CONTACTS_SRC)
    print(f"  {len(c_rows)} contacts, {len(c_fields)} columns")

    print(f"Loading {DEALS_SRC}...")
    d_fields, d_rows = load_rows(DEALS_SRC)
    print(f"  {len(d_rows)} deals, {len(d_fields)} columns")

    # Contacts: simple random sample
    n_c = min(N_CONTACTS, len(c_rows))
    contact_sample = random.sample(c_rows, n_c)
    sample_contact_ids = {r.get("id") for r in contact_sample if r.get("id")}
    print(f"Sampled {len(contact_sample)} contacts ({len(sample_contact_ids)} with ids)")

    # Deals: priorize linked, then fill with random unlinked
    linked_pool = [r for r in d_rows if r.get("main_contact_id") in sample_contact_ids]
    unlinked_pool = [r for r in d_rows if r.get("main_contact_id") not in sample_contact_ids]
    print(f"  deals linked to sampled contacts: {len(linked_pool)}")
    print(f"  deals unlinked (orphan main_contact for sample): {len(unlinked_pool)}")

    n_d = min(N_DEALS, len(d_rows))
    if len(linked_pool) >= n_d:
        deal_sample = random.sample(linked_pool, n_d)
    else:
        deal_sample = list(linked_pool)
        need = n_d - len(deal_sample)
        if need > 0 and unlinked_pool:
            deal_sample += random.sample(unlinked_pool, min(need, len(unlinked_pool)))

    print(f"Sampled {len(deal_sample)} deals")

    write_rows(f"{OUT_DIR}/contacts_1000.csv", c_fields, contact_sample)
    write_rows(f"{OUT_DIR}/deals_1000.csv", d_fields, deal_sample)
    print(f"Wrote {OUT_DIR}/contacts_1000.csv and {OUT_DIR}/deals_1000.csv")


if __name__ == "__main__":
    main()
