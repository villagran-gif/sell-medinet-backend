#!/usr/bin/env python3
"""
Phase 2+3: Crear 30 CRM Deal Status pipeline-aware y migrar los 4691 deals.

  1. Agrega custom fields zendesk_stage_id + zendesk_pipeline_id a CRM Deal Status
  2. Crea 30 stages con names "BAR - CANDIDATO" etc., guardando zendesk_stage_id
     y type heuristico (Won/Lost/Open) y color
  3. Construye mapping zendesk_stage_id -> new status name
  4. PATCH cada deal: status = new_status_name (por zd_stage_id)

Idempotente.
"""
import csv, json, os, sys, urllib.request, urllib.parse, urllib.error
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
csv.field_size_limit(sys.maxsize)

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL","").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY","")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET","")
AUTH = f"token {KEY}:{SECRET}"

PIPELINE_PREFIX = {
    "Pipeline Balones": "BAL",
    "Pipeline Cirugía Bariátricas": "BAR",
    "Pipeline Cirugía General": "GEN",
    "Pipeline Cirugía Plastica": "PLA",
}

# Workflow position dentro de cada pipeline (mismo orden conceptual)
POSITION_RANK = {
    "CANDIDATO": 10, "CANDIDATOS": 10,
    "ORDEN DE EXAMENES": 20,
    "EXAMENES ENVIADOS": 30, "EXAMENES PRE-PAD ENVIADOS": 30,
    "EXAMENES ALLURION": 30, "EXAMENES ORBERA": 30,
    "PROCESO PREOP": 40, "PROCESO PRE-OPERATORIO": 40,
    "CONTROLES PRE-INSTALACIÓN": 45,
    "CERRADO AGENDADO": 50,
    "CERRADO OPERADO": 60, "CERRADO INSTALADO": 60,
    "SIN RESPUESTA": 90,
    "SUSPENDIDO": 95,
    "DESCALIFICADO": 99,
}


def http(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
        headers={"Authorization":AUTH,"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except: return e.code, {}


def upsert_custom_field(dt, fieldname, fieldtype, label, **kwargs):
    """Insert if not exists; ignore if exists."""
    flt = json.dumps([["dt","=",dt],["fieldname","=",fieldname]])
    code, data = http("GET", f"/api/method/frappe.client.get_list?doctype=Custom+Field&filters={urllib.parse.quote(flt)}&fields=%5B%22name%22%5D&limit_page_length=1")
    if code == 200 and data.get("message"):
        return "EXISTS"
    doc = {"doctype":"Custom Field","dt":dt,"fieldname":fieldname,
           "fieldtype":fieldtype,"label":label,**kwargs}
    code, _ = http("POST","/api/method/frappe.client.insert",{"doc":doc})
    return "OK" if code in (200,201) else "ERR"


def stage_type(stage_name):
    up = stage_name.upper()
    if "CERRADO" in up: return "Won"
    if up in ("SUSPENDIDO","SIN RESPUESTA","DESCALIFICADO"): return "Lost"
    return "Open"


def stage_color(stage_name):
    t = stage_type(stage_name)
    return {"Won":"green","Lost":"red","Open":"blue"}[t]


def main():
    if not (SITE and KEY and SECRET): sys.exit("env")

    # 1. Add custom fields a CRM Deal Status
    print("=== 1. Custom fields en CRM Deal Status ===")
    for fn, ft, lbl in [
        ("zendesk_stage_id","Data","Zendesk Stage ID"),
        ("zendesk_pipeline_id","Data","Zendesk Pipeline ID"),
        ("zendesk_pipeline_name","Data","Zendesk Pipeline Name"),
    ]:
        s = upsert_custom_field("CRM Deal Status", fn, ft, lbl,
                                in_standard_filter=1, search_index=1)
        print(f"  {fn}: {s}")

    # 2. Read source CSV → unique tuples
    print("\n=== 2. Leyendo source ===")
    tuples = {}  # stage_id -> (pipeline_id, pipeline_name, stage_name)
    with open("/tmp/zendesk-export-new/deals.0.csv") as f:
        for r in csv.DictReader(f):
            pid = (r.get("pipeline_id") or "").strip()
            pname = (r.get("pipeline_name") or "").strip()
            sid = (r.get("stage_id") or "").strip()
            sname = (r.get("stage_name") or "").strip()
            if pid and sid:
                tuples[sid] = (pid, pname, sname)
    print(f"  {len(tuples)} stages unicos")

    # 3. Create 30 new stages
    print("\n=== 3. Creando stages ===")
    sid_to_status_name = {}
    for sid, (pid, pname, sname) in tuples.items():
        prefix = PIPELINE_PREFIX.get(pname, pname[:3].upper())
        new_name = f"{prefix} - {sname}"
        sid_to_status_name[sid] = new_name
        position = POSITION_RANK.get(sname.upper(), 50)
        doc = {
            "doctype":"CRM Deal Status",
            "deal_status": new_name,
            "type": stage_type(sname),
            "color": stage_color(sname),
            "position": position,
            "zendesk_stage_id": sid,
            "zendesk_pipeline_id": pid,
            "zendesk_pipeline_name": pname,
        }
        code, resp = http("POST","/api/method/frappe.client.insert",{"doc":doc})
        if code in (200,201):
            print(f"  OK   {new_name}")
        elif "DuplicateEntry" in json.dumps(resp):
            print(f"  EXIS {new_name}")
        else:
            print(f"  ERR  {new_name}: {code} {str(resp)[:100]}")

    # Save mapping
    with open("/tmp/migration/stage_id_to_status.json","w") as f:
        json.dump(sid_to_status_name, f, indent=2, ensure_ascii=False)
    print(f"\n  Mapping saved to /tmp/migration/stage_id_to_status.json")

    # 4. Migrate deals: PATCH status based on zd_stage_id
    print("\n=== 4. Migrando 4691 deals ===")
    fields = json.dumps(["name","status","zd_stage_id"])
    start = 0; BATCH = 500
    updated = 0; skipped = 0; errors = 0

    def patch_deal(deal_name, new_status):
        c, _ = http("PUT", f"/api/resource/CRM%20Deal/{urllib.parse.quote(deal_name,safe='')}",
                    {"status": new_status})
        return c in (200,202)

    while True:
        url = (f"/api/method/frappe.client.get_list?doctype=CRM+Deal"
               f"&fields={urllib.parse.quote(fields)}"
               f"&limit_start={start}&limit_page_length={BATCH}&order_by=name")
        code, data = http("GET", url)
        items = data.get("message", []) if code == 200 else []
        if not items: break

        with ThreadPoolExecutor(max_workers=4) as ex:
            futures = []
            for it in items:
                sid = (it.get("zd_stage_id") or "").strip()
                if not sid:
                    skipped += 1; continue
                new_status = sid_to_status_name.get(sid)
                if not new_status:
                    skipped += 1; continue
                if it.get("status") == new_status:
                    skipped += 1; continue  # already migrated
                futures.append(ex.submit(patch_deal, it["name"], new_status))
            for f in as_completed(futures):
                if f.result(): updated += 1
                else: errors += 1
        start += BATCH
        print(f"  {start} processed  updated={updated} skipped={skipped} errors={errors}")

    print(f"\n=== DONE ===")
    print(f"  Updated: {updated}  Skipped: {skipped}  Errors: {errors}")


if __name__ == "__main__":
    main()
