#!/usr/bin/env python3
"""
Importa tickets de Zendesk Support a doctype Zendesk Ticket en Frappe.

  1. Lee users.csv → user_id → {email, phone, name}
  2. Pre-fetch Frappe Contacts → email/phone → contact name (in memory)
  3. Por cada ticket: resolve requester → contact, insert Zendesk Ticket
  4. Idempotente: si zendesk_ticket_id existe, skip

Uso:
  python3 migration/import-tickets.py [--limit N] [--workers 4]
"""
import argparse, csv, json, os, sys, time, re, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter

csv.field_size_limit(sys.maxsize)

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL","").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY","")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET","")
AUTH = f"token {KEY}:{SECRET}"

TICKETS_CSV = "/tmp/zendesk-support/extracted/tickets.csv"
USERS_CSV = "/tmp/zendesk-support/extracted/users.csv"


def http(method, path, body=None, timeout=30, retries=3):
    data = json.dumps(body).encode() if body else None
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(f"{SITE}{path}",data=data,method=method,
            headers={"Authorization":AUTH,"Content-Type":"application/json"})
        try:
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code >= 500 and attempt < retries-1:
                time.sleep(2**attempt); continue
            try: return e.code, json.loads(e.read())
            except: return e.code, {}
        except (TimeoutError, urllib.error.URLError, ConnectionError) as e:
            last = e
            if attempt < retries-1:
                time.sleep(2**attempt); continue
            return 599, {"_raw": str(e)}
    return 599, {"_raw": str(last)}


def normalize_phone(p):
    if not p: return None
    s = re.sub(r"[^\d]", "", str(p))
    return s if len(s) >= 7 else None


def parse_dt(s):
    """Zendesk format '2025-04-04 20:38:46' → Frappe '2025-04-04 20:38:46'."""
    if not s: return None
    s = s.strip()
    if len(s) < 19: return None
    return s[:19]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--workers", type=int, default=4)
    args = p.parse_args()

    if not (SITE and KEY and SECRET): sys.exit("env missing")

    # 1. Build user_id → user info map
    print("Loading users...")
    user_info = {}
    with open(USERS_CSV, encoding="utf-8") as f:
        for r in csv.DictReader(f, delimiter=";"):
            uid = (r.get("id") or "").strip()
            if uid:
                user_info[uid] = {
                    "email": (r.get("email") or "").strip().lower(),
                    "phone": normalize_phone(r.get("phone")),
                    "name": (r.get("name") or "").strip(),
                }
    print(f"  {len(user_info)} users")

    # 2. Build Frappe Contact lookup: email/phone/name → contact name
    print("Loading Frappe Contacts...")
    email_to_contact = {}
    phone_to_contact = {}
    name_to_contact = {}
    start = 0; BATCH = 500
    while True:
        fields = urllib.parse.quote(json.dumps(["name","email_id","mobile_no","phone","full_name"]))
        url = f"/api/method/frappe.client.get_list?doctype=Contact&fields={fields}&limit_start={start}&limit_page_length={BATCH}"
        code, data = http("GET", url)
        items = data.get("message",[]) if code==200 else []
        if not items: break
        for c in items:
            n = c["name"]
            em = (c.get("email_id") or "").strip().lower()
            if em: email_to_contact[em] = n
            for ph_raw in (c.get("mobile_no"), c.get("phone")):
                ph = normalize_phone(ph_raw)
                if ph: phone_to_contact[ph] = n
            fn = (c.get("full_name") or "").strip().lower()
            if fn: name_to_contact[fn] = n
        start += BATCH
    print(f"  {len(email_to_contact)} by email, {len(phone_to_contact)} by phone, {len(name_to_contact)} by name")

    # 3. Resolve requester per ticket
    def resolve_contact(requester_id):
        u = user_info.get(requester_id)
        if not u: return None
        if u["email"] and u["email"] in email_to_contact:
            return email_to_contact[u["email"]]
        if u["phone"] and u["phone"] in phone_to_contact:
            return phone_to_contact[u["phone"]]
        if u["name"] and u["name"].lower() in name_to_contact:
            return name_to_contact[u["name"].lower()]
        return None

    def translate(row):
        tid = (row.get("id") or "").strip()
        if not tid: return None
        req_id = (row.get("requester_id") or "").strip()
        u = user_info.get(req_id, {})
        contact_name = resolve_contact(req_id)
        return {
            "doctype": "Zendesk Ticket",
            "zendesk_ticket_id": tid,
            "subject": (row.get("subject") or "")[:140],
            "status": (row.get("status") or "").strip() or None,
            "channel": (row.get("channel") or "").strip() or None,
            "requester_email": u.get("email"),
            "contact": contact_name,
            "requester_id": req_id or None,
            "assignee_id": (row.get("assignee_id") or "").strip() or None,
            "submitter_id": (row.get("submitter_id") or "").strip() or None,
            "organization_id": (row.get("organization_id") or "").strip() or None,
            "form": (row.get("form") or "").strip() or None,
            "group_name": (row.get("group") or "").strip() or None,
            "brand": (row.get("brand") or "").strip() or None,
            "priority": (row.get("priority") or "").strip() or None,
            "created_at": parse_dt(row.get("created_at")),
            "updated_at": parse_dt(row.get("updated_at")),
            "solved_at": parse_dt(row.get("solved_at")),
            "first_reply_minutes": int(float(row["first_reply_time_in_minutes"])) if row.get("first_reply_time_in_minutes") else None,
            "full_resolution_minutes": int(float(row["full_resolution_time_in_minutes"])) if row.get("full_resolution_time_in_minutes") else None,
            "satisfaction_score": (row.get("satisfaction_score") or "").strip() or None,
            "recipient": (row.get("recipient") or "").strip() or None,
            "external_id": (row.get("external_id") or "").strip() or None,
        }

    # 4. Insert tickets in parallel
    print("\nLoading tickets...")
    with open(TICKETS_CSV, encoding="utf-8") as f:
        rows = list(csv.DictReader(f, delimiter=";"))
    if args.limit: rows = rows[:args.limit]
    print(f"  {len(rows)} tickets")

    stats = Counter()
    started = time.time()

    def insert(doc):
        c, r = http("POST","/api/method/frappe.client.insert",{"doc":doc})
        if c in (200,201): return "INS"
        body = json.dumps(r).lower()
        if "duplicateentry" in body: return "DUP"
        return "ERR"

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = []
        for r in rows:
            doc = translate(r)
            if not doc:
                stats["skip"] += 1; continue
            futures.append(ex.submit(insert, doc))
        for done, f in enumerate(as_completed(futures), 1):
            stats[f.result()] += 1
            if done % 1000 == 0:
                el = time.time() - started
                print(f"  {done}/{len(futures)} in {el:.0f}s  {dict(stats)}")

    print(f"\n=== DONE in {time.time()-started:.0f}s ===")
    print(f"  stats: {dict(stats)}")
    # Coverage check
    code, data = http("GET","/api/method/frappe.client.get_count?doctype=Zendesk+Ticket&filters=%5B%5B%22contact%22%2C%22is%22%2C%22set%22%5D%5D")
    print(f"  Tickets with contact link: {data.get('message',0)}")


if __name__ == "__main__":
    main()
