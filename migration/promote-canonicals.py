#!/usr/bin/env python3
"""
Promueve campos zd_* → canonicos Frappe Contact para que la vista FCRM
del CRM (/crm/contacts/view/list) se vea poblada.

  zd_email             → email_id
  zd_mobile (cleaned)  → mobile_no
  zd_phone  (cleaned)  → phone
  zd_organisation_name → company_name
  zd_is_organisation   → is_company (1/0)

Idempotente. Skipea phones invalidos (deja en zd_*).

Uso:
  python3 migration/promote-canonicals.py [--limit N] [--workers 8]

Env: FRAPPE_CLOUD_*
"""
import os, sys, json, re, time, argparse, urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"


def http(m, p, body=None, timeout=30):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{SITE}{p}", data=data, method=m,
        headers={"Authorization": AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except: return e.code, {}
    except Exception as e:
        return 599, {"_raw": str(e)}


def clean_phone(v):
    """Strip leading apostrophe and Frappe-acceptable format."""
    if not v: return None
    s = str(v).strip().lstrip("'").strip()
    s = re.sub(r"[^\d+]", "", s)
    if len(s) < 7: return None
    return s


def clean_email(v):
    if not v: return None
    s = str(v).strip().lower()
    return s if "@" in s and "." in s else None


def get_page(start, batch=200):
    fields = json.dumps([
        "name", "first_name", "last_name", "email_id", "mobile_no", "phone",
        "company_name",
        "zd_email", "zd_mobile", "zd_phone", "zd_organisation_name",
        "zd_is_organisation", "zd_first_name", "zd_last_name",
    ])
    code, data = http("GET",
        f"/api/method/frappe.client.get_list?doctype=Contact"
        f"&fields={urllib.parse.quote(fields)}"
        f"&limit_start={start}&limit_page_length={batch}"
        f"&order_by=modified+desc")
    return data.get("message", []) if code == 200 else []


def needs_update(c):
    """Returns dict of fields to update, or None if nothing to do."""
    upd = {}
    if not c.get("email_id"):
        em = clean_email(c.get("zd_email"))
        if em: upd["email_id"] = em
    if not c.get("mobile_no"):
        ph = clean_phone(c.get("zd_mobile"))
        if ph: upd["mobile_no"] = ph
    if not c.get("phone"):
        ph = clean_phone(c.get("zd_phone"))
        if ph: upd["phone"] = ph
    if not c.get("company_name"):
        co = (c.get("zd_organisation_name") or "").strip()
        if co: upd["company_name"] = co
    is_org = (c.get("zd_is_organisation") or "").strip().lower()
    if is_org == "true":
        upd["is_company"] = 1
    elif is_org == "false" and "is_company" not in upd:
        upd["is_company"] = 0
    return upd or None


def patch_one(name, body):
    enc = urllib.parse.quote(name, safe="")
    c, r = http("PUT", f"/api/resource/Contact/{enc}", body)
    if c in (200, 202): return "OK"
    err = json.dumps(r).lower()
    if "invalidphonenumber" in err or "invalid email" in err:
        # Strip the offending field and retry
        body2 = {k: v for k, v in body.items() if k not in ("mobile_no", "phone", "email_id")}
        if not body2: return "SKIP"
        c2, _ = http("PUT", f"/api/resource/Contact/{enc}", body2)
        return "OK_NOVAL" if c2 in (200, 202) else "ERR"
    return "ERR"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--workers", type=int, default=8)
    args = p.parse_args()

    if not (SITE and KEY and SECRET): sys.exit("env missing")

    started = time.time()
    stats = Counter()
    processed = 0
    start = 0
    BATCH = 200

    while True:
        page = get_page(start, BATCH)
        if not page: break
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futures = []
            for c in page:
                upd = needs_update(c)
                if upd:
                    futures.append(ex.submit(patch_one, c["name"], upd))
                    processed += 1
                else:
                    stats["NOOP"] += 1
            for f in as_completed(futures):
                stats[f.result()] += 1
        start += BATCH
        if args.limit and start >= args.limit: break
        if start % 1000 == 0:
            print(f"  {start} processed in {time.time()-started:.0f}s  stats={dict(stats)}")

    print(f"\n=== Done in {time.time()-started:.0f}s ===")
    print(f"  stats: {dict(stats)}")


if __name__ == "__main__":
    main()
