#!/usr/bin/env python3
"""
Configura la list view del FCRM para CRM Deal con las columnas que tiene
Zendesk Sell (foto 1 enviada por usuario):

  Nombre del trato (lead_name)
  Fase del pipeline (status)
  Propiedad / Asignado a (deal_owner)
  FECHA DE CIRUGÍA (fecha_cirugia)
  Agregado el (creation)
  Tramo/Modalidad (tramo_modalidad)
  CIRUGÍA / PROCEDIMIENTO (cirugia_procedimiento)
  SUCURSAL (sucursal)
  URL-MEDINET (url_medinet)
  Valor (deal_value)
  RUT o ID (rut_normalizado)
  Contacto (contact link)
  Colaborador BAR (zd_custom_colaborador_1_bar)
  Última modificación (modified)

Order_by: modified desc.
"""
import os, sys, json, urllib.request, urllib.parse

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"


def http(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
        headers={"Authorization": AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except: return e.code, {}


COLUMNS = [
    {"label": "Nombre del trato",      "key": "lead_name",                    "type": "Data",      "width": "16rem"},
    {"label": "Fase",                  "key": "status",                       "type": "Link",      "width": "11rem"},
    {"label": "Propiedad",             "key": "deal_owner",                   "type": "Link",      "width": "10rem"},
    {"label": "Fecha cirugía",         "key": "fecha_cirugia",                "type": "Date",      "width": "10rem"},
    {"label": "Agregado el",           "key": "zd_created_at",                "type": "Data"    ,  "width": "10rem"},
    {"label": "Tramo/Modalidad",       "key": "tramo_modalidad",              "type": "Select",    "width": "9rem"},
    {"label": "Cirugía/Procedimiento", "key": "cirugia_procedimiento",        "type": "Select",    "width": "12rem"},
    {"label": "Sucursal",              "key": "sucursal",                     "type": "Select",    "width": "12rem"},
    {"label": "URL Medinet",           "key": "url_medinet",                  "type": "Data",      "width": "10rem"},
    {"label": "Valor",                 "key": "deal_value",                   "type": "Currency",  "width": "9rem"},
    {"label": "RUT",                   "key": "rut_normalizado",              "type": "Data",      "width": "10rem"},
    {"label": "Contacto",              "key": "contact",                      "type": "Link",      "width": "12rem"},
    {"label": "Colaborador BAR",       "key": "zd_custom_colaborador_1_bar",  "type": "Data",      "width": "8rem"},
    {"label": "Modificado",            "key": "modified",                     "type": "Datetime",  "width": "9rem"},
]
ROWS = ["name"] + [c["key"] for c in COLUMNS]


def main():
    body = {
        "columns": json.dumps(COLUMNS, ensure_ascii=False),
        "rows": json.dumps(ROWS, ensure_ascii=False),
        "order_by": "modified desc",
        "load_default_columns": 0,
    }
    code, resp = http("PUT", "/api/resource/CRM%20View%20Settings/3", body)
    print(f"  {'OK' if code in (200,202) else f'ERR {code}'}  CRM Deal list view ({len(COLUMNS)} columns)")
    if code not in (200,202): print(f"  {resp}")


if __name__ == "__main__":
    main()
