#!/usr/bin/env python3
"""
Fase 1 - Discovery: lee TODOS los CSVs de Zendesk export y produce
/tmp/migration/discovery.json con las listas únicas de:
  - users (owners + creators)
  - pipelines (con sus stages)
  - tags
  - resource refs para documents (resource_type, resource_id)
  - field inventories por entity (lista de columnas + non-empty count)

Read-only, no toca el site.
"""
import csv, json, os, sys
from collections import Counter, defaultdict

csv.field_size_limit(sys.maxsize)

SOURCE = "/tmp/zendesk-export-new"
OUT_DIR = "/tmp/migration"
OUT_FILE = f"{OUT_DIR}/discovery.json"

ENTITIES = {
    "contacts": "contacts.0.csv",
    "deals": "deals.0.csv",
    "leads": "leads.0.csv",
    "notes": "notes.0.csv",
    "tasks": "tasks.0.csv",
    "documents": "documents.0.csv",
}


def load(path):
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    discovery = {"entities": {}, "users": [], "pipelines": {}, "stages": [], "tags": [], "documents_by_resource": {}}

    users = Counter()
    pipelines = defaultdict(set)  # pipeline_name -> set(stage_names)
    tags = Counter()
    docs_by_resource = defaultdict(list)  # (rtype, rid) -> [doc_meta]

    for ent, fname in ENTITIES.items():
        path = f"{SOURCE}/{fname}"
        if not os.path.exists(path):
            print(f"  ! missing {path}, skip"); continue
        cols, rows = load(path)

        nonempty = Counter()
        for r in rows:
            for c, v in r.items():
                if v and str(v).strip(): nonempty[c] += 1
        discovery["entities"][ent] = {
            "rows": len(rows),
            "cols": cols,
            "nonempty_per_col": dict(nonempty),
        }
        print(f"  {ent}: {len(rows)} rows, {len(cols)} cols")

        # Owners / creators
        for r in rows:
            for k in ("owner", "creator"):
                v = (r.get(k) or "").strip()
                if v: users[v] += 1

        if ent == "deals":
            for r in rows:
                pn = (r.get("pipeline_name") or "").strip()
                sn = (r.get("stage_name") or "").strip()
                if pn:
                    pipelines[pn].add(sn or "<no_stage>")

        # Tags
        for r in rows:
            t = (r.get("tags") or "").strip()
            if t:
                for tag in t.split(","):
                    tag = tag.strip()
                    if tag: tags[tag] += 1

        if ent == "documents":
            for r in rows:
                rtype = (r.get("documentable_type") or "").strip()
                rid = (r.get("documentable_id") or "").strip()
                if rtype and rid:
                    docs_by_resource[f"{rtype}:{rid}"].append({
                        "id": r.get("id"),
                        "name": r.get("uploaded_file_name"),
                        "size": r.get("uploaded_file_size_in_bytes"),
                        "created_at": r.get("created_at"),
                    })

    discovery["users"] = [{"name": n, "count": c} for n, c in users.most_common()]
    discovery["pipelines"] = {p: sorted(s) for p, s in pipelines.items()}
    discovery["stages"] = sorted({s for stages in pipelines.values() for s in stages})
    discovery["tags"] = [{"name": n, "count": c} for n, c in tags.most_common()]
    discovery["documents_by_resource"] = dict(docs_by_resource)

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(discovery, f, ensure_ascii=False, indent=2)

    print(f"\n=== Summary ===")
    print(f"  Users únicos: {len(users)}")
    print(f"  Pipelines: {len(pipelines)}  Stages: {len(discovery['stages'])}")
    print(f"  Tags únicos: {len(tags)}")
    print(f"  Documents por resource: {len(docs_by_resource)}")
    rel_docs = sum(1 for k in docs_by_resource if k.split(':',1)[0] in ("Lead","Deal","Contact","SalesAccount"))
    print(f"    relevantes (Lead/Deal/Contact/SalesAccount): {rel_docs}")

    print(f"\nWrote {OUT_FILE}")


if __name__ == "__main__":
    main()
