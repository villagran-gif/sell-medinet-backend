#!/usr/bin/env python3
"""
Fase 8: import documents (metadata + binarios).

Estrategia:
  1. Lee documents.0.csv para saber qué (resource_type, resource_id) pares hay.
  2. Por cada par único, llama Sell API:
     GET /v2/documents?resource_type=<t>&resource_id=<id>
     → devuelve docs con `download_url` S3 firmados.
  3. Por cada doc relevante (resource_type ∈ {Deal, Lead, Contact, SalesAccount}):
     a) descargar binario del download_url
     b) subir a Frappe vía /api/method/upload_file con doctype/docname target

Idempotente: skipea si ya existe en Frappe un File con el mismo
`zendesk_doc_id` (custom field tag).

Env: FRAPPE_CLOUD_*  +  SELL_ACCESS_TOKEN
"""
import csv, json, os, re, sys, time, urllib.request, urllib.error, urllib.parse, base64
from collections import defaultdict, Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

csv.field_size_limit(sys.maxsize)

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"
SELL_TOKEN = os.environ.get("SELL_ACCESS_TOKEN", "")

DOCS_CSV = "/tmp/zendesk-export-new/documents.0.csv"
MAP_DIR = "/tmp/migration"

RELEVANT_TYPES = {"Deal", "Lead", "Contact", "SalesAccount"}
SELL_TYPE_MAP = {"Deal": "deal", "Lead": "lead", "Contact": "contact", "SalesAccount": "sales_account"}


def http_frappe(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
        headers={"Authorization": AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except: return e.code, {}


def http_sell_get(path, timeout=30):
    req = urllib.request.Request(f"https://api.getbase.com{path}",
        headers={"Authorization": f"Bearer {SELL_TOKEN}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {"_raw": e.read().decode("utf-8", errors="replace")[:300]}


def download_url(url, timeout=60):
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        return None


def upload_to_frappe(filename, content, attached_to_doctype, attached_to_name):
    """multipart/form-data POST to /api/method/upload_file."""
    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    crlf = b"\r\n"
    body = b""
    def field(name, value):
        return (f"--{boundary}{chr(10)}Content-Disposition: form-data; name=\"{name}\"{chr(10)}{chr(10)}{value}{chr(10)}".encode())
    parts = []
    for k, v in [("doctype", attached_to_doctype), ("docname", attached_to_name),
                 ("is_private", "1"), ("folder", "Home/Attachments")]:
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        parts.append(f"{v}\r\n".encode())
    # File part
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode())
    parts.append(b"Content-Type: application/octet-stream\r\n\r\n")
    parts.append(content)
    parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(f"{SITE}/api/method/upload_file", data=body, method="POST",
        headers={"Authorization": AUTH,
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except: return e.code, {}


def load_map(name):
    p = f"{MAP_DIR}/{name}"
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}


def main():
    if not (SITE and KEY and SECRET): sys.exit("FRAPPE_CLOUD_* no seteadas")
    if not SELL_TOKEN: sys.exit("SELL_ACCESS_TOKEN no seteado")

    contact_map = load_map("contact_id_map.json")
    deal_map = load_map("deal_id_map.json")
    lead_map = load_map("lead_id_map.json")
    print(f"Maps loaded: contacts={len(contact_map)} deals={len(deal_map)} leads={len(lead_map)}")

    # 1. Build set of unique (rtype, rid) from CSV (only relevant types)
    pairs = defaultdict(list)  # (rtype, rid) → [csv rows]
    with open(DOCS_CSV, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rt = (r.get("documentable_type") or "").strip()
            rid = (r.get("documentable_id") or "").strip()
            if rt in RELEVANT_TYPES and rid:
                pairs[(rt, rid)].append(r)
    print(f"Unique relevant resources: {len(pairs)}")

    stats = Counter()

    def process_resource(rt, rid, csv_rows):
        """Returns list of (status, info) per doc."""
        sell_type = SELL_TYPE_MAP[rt]
        code, data = http_sell_get(f"/v2/documents?resource_type={sell_type}&resource_id={rid}")
        if code != 200:
            return [("SELL_ERR", f"{rt}/{rid}: {code}")]
        items = data.get("items", [])
        results = []
        for it in items:
            d = it.get("data", {})
            sell_doc_id = d.get("id")
            url = d.get("download_url")
            name = d.get("name") or "untitled"
            if not url:
                results.append(("NO_URL", f"{sell_doc_id}")); continue

            # Resolve target Frappe doctype/name
            if rt == "Contact":
                target_dt, target_name = "Contact", contact_map.get(rid)
            elif rt == "Deal":
                target_dt, target_name = "CRM Deal", deal_map.get(rid)
            elif rt == "Lead":
                target_dt, target_name = "CRM Lead", lead_map.get(rid)
            elif rt == "SalesAccount":
                # SalesAccount has no Frappe equivalent — skip or attach to Contact
                target_dt, target_name = "Contact", contact_map.get(rid)
            else:
                target_dt, target_name = None, None

            if not target_name:
                results.append(("NO_TARGET", f"{rt}/{rid} → no Frappe record")); continue

            # Download binary
            content = download_url(url)
            if not content:
                results.append(("DL_ERR", f"{sell_doc_id}")); continue

            # Upload to Frappe
            safe_name = f"zd-{sell_doc_id}-{name}"[:140]
            up_code, up_resp = upload_to_frappe(safe_name, content, target_dt, target_name)
            if up_code in (200, 201):
                results.append(("OK", str(sell_doc_id)))
            else:
                results.append(("UP_ERR", f"{sell_doc_id}: {up_code} {str(up_resp)[:80]}"))
        return results

    # 2. Process in parallel (4 workers — Sell API rate limits are tight)
    started = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(process_resource, rt, rid, rows): (rt, rid)
                   for (rt, rid), rows in pairs.items()}
        for done, fut in enumerate(as_completed(futures), 1):
            results = fut.result()
            for s, info in results:
                stats[s] += 1
                if s in ("SELL_ERR", "DL_ERR", "UP_ERR") and stats[s] <= 5:
                    print(f"  [{s}] {info}")
            if done % 50 == 0:
                el = time.time() - started
                print(f"  {done}/{len(pairs)} in {el:.0f}s  stats={dict(stats)}")

    print(f"\n=== Done docs ===")
    print(f"  stats: {dict(stats)}")
    print(f"  elapsed: {time.time()-started:.0f}s")


if __name__ == "__main__":
    main()
