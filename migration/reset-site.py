#!/usr/bin/env python3
"""
Borra TODOS los registros de Contact + CRM Deal + CRM Lead + CRM Task + Comment
del site. Idempotente, batches de 200.

Uso:
  python3 migration/reset-site.py --dry-run     (default, solo cuenta)
  python3 migration/reset-site.py --execute     (ejecuta el delete)

Env: FRAPPE_CLOUD_SITE_URL, FRAPPE_CLOUD_API_KEY, FRAPPE_CLOUD_API_SECRET
"""
import os, sys, json, time, argparse, urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

DOCTYPES = ["Comment", "CRM Task", "CRM Lead", "CRM Deal", "Contact"]
BATCH = 200


def http(method, path, body=None, timeout=60, retries=3):
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


def count(doctype):
    code, data = http("GET", f"/api/method/frappe.client.get_count?doctype={urllib.parse.quote(doctype)}")
    return data.get("message", 0) if code == 200 else None


def _del_one(doctype, name):
    enc = urllib.parse.quote(str(name), safe="")
    c, _ = http("DELETE", f"/api/resource/{urllib.parse.quote(doctype)}/{enc}")
    return c in (200, 202, 204)


def delete_all(doctype, workers=8):
    """Returns (deleted, errors). Parallel REST DELETE with workers."""
    deleted = 0; errors = 0
    while True:
        fields = json.dumps(["name"])
        code, data = http("GET",
            f"/api/method/frappe.client.get_list?doctype={urllib.parse.quote(doctype)}"
            f"&fields={urllib.parse.quote(fields)}&limit_page_length={BATCH}")
        items = data.get("message", []) if code == 200 else []
        if not items: break
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_del_one, doctype, it["name"]) for it in items]
            for f in as_completed(futures):
                if f.result(): deleted += 1
                else: errors += 1
        print(f"    {doctype}: {deleted} deleted, {errors} errors")
    return deleted, errors


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--execute", action="store_true",
                   help="Realmente borrar. Sin esta flag, solo cuenta (dry-run).")
    args = p.parse_args()

    if not (SITE and KEY and SECRET):
        sys.exit("FRAPPE_CLOUD_* no seteadas")

    print(f"=== {'EXECUTE' if args.execute else 'DRY-RUN'} ===")
    print(f"Site: {SITE}\n")

    counts = {}
    for dt in DOCTYPES:
        c = count(dt)
        counts[dt] = c
        print(f"  {dt:12s}: {c}")
    total = sum(v for v in counts.values() if v)
    print(f"\nTOTAL a borrar: {total}")

    if not args.execute:
        print("\nDry-run. Re-correr con --execute para borrar.")
        return

    print("\n=== Borrando ===")
    started = time.time()
    grand = 0
    for dt in DOCTYPES:
        if counts.get(dt) == 0:
            continue
        print(f"  Borrando {dt}...")
        d, e = delete_all(dt)
        print(f"  → {d} borrados, {e} errores")
        grand += d
    print(f"\nTotal borrados: {grand} en {time.time()-started:.0f}s")

    print("\n=== Counts post-reset ===")
    for dt in DOCTYPES:
        print(f"  {dt:12s}: {count(dt)}")


if __name__ == "__main__":
    main()
