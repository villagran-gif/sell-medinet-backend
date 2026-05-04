#!/usr/bin/env python3
"""
Importa records desde Zendesk CSV exports → Frappe Cloud.

Razón: la Zendesk Sell API no expone TODOS los custom fields de Lead
(devuelve `[]` para custom_fields del lead), pero el CSV export sí los tiene.
Además el CSV tiene más records (incluye soft-deleted o filtrados de la API).

Uso:
  python3 migration/import-from-csv.py --entity contacts --csv /tmp/zendesk-export/contacts.0.csv
  python3 migration/import-from-csv.py --entity leads    --csv /tmp/zendesk-export/leads.0.csv
  python3 migration/import-from-csv.py --entity deals    --csv /tmp/zendesk-export/deals.0.csv

Modos:
  --dry-run        solo print
  --mode insert    solo insertar nuevos (skip si existe — match por RUT/email)
  --mode replace   borrar todos los existentes del DocType primero, luego insertar
  --limit N        solo procesar primeros N rows
  --start-row N    skip primeros N rows (resume)

Env: FRAPPE_CLOUD_SITE_URL, FRAPPE_CLOUD_API_KEY, FRAPPE_CLOUD_API_SECRET
"""

import os
import sys
import csv
import json
import time
import argparse
import urllib.request
import urllib.error
import urllib.parse
import re
from collections import Counter

SITE = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")
AUTH = f"token {KEY}:{SECRET}"

# Increase CSV field size limit (Zendesk has long fields)
csv.field_size_limit(sys.maxsize)

# ─────────────────────────────────────────────────────────────────────────────
# Field mapping CSV column → Frappe fieldname
# (replica + adapta de translator.js — los CSV usan prefijos "custom (X) ")
# ─────────────────────────────────────────────────────────────────────────────

# Contact CSV columns (115 total) → Frappe Contact
# Note: prefijo "custom (contact) " en cada custom field
CONTACT_CSV_TO_FRAPPE = {
    # Standard
    "first_name": "first_name",
    "last_name": "last_name",
    "email": "_email",
    "phone": "_phone",
    "mobile": "_mobile",
    "city": "ciudad",  # standard col, also have custom Ciudad
    "address": "_address",
    "tags": "_tags",  # comma-separated, ignore for now

    # Custom (contact) prefix
    "custom (contact) RUT o ID": "rut",
    "custom (contact) RUT o ID#1": "rut",
    "custom (contact) RUT_normalizado": "rut_normalizado",
    "custom (contact) RUT_normalizado#1": "rut_normalizado",
    "custom (contact) Edad": "edad",
    "custom (contact) Edad #1": "edad",
    "custom (contact) Edad #2": "edad",
    "custom (contact) Edad #3": "edad",
    "custom (contact) Edad #4": "edad",
    "custom (contact) Edad #5": "edad",
    "custom (contact) Fecha Nacimiento": "fecha_nacimiento",
    "custom (contact) Fecha Nacimiento#1": "fecha_nacimiento",
    "custom (contact) Peso": "peso_kg",
    "custom (contact) Peso #1": "peso_kg",
    "custom (contact) Peso #2": "peso_kg",
    "custom (contact) Peso #3": "peso_kg",
    "custom (contact) Peso #4": "peso_kg",
    "custom (contact) Peso#1": "peso_kg",
    "custom (contact) Estatura": "estatura_m",
    "custom (contact) Estatura #1": "estatura_m",
    "custom (contact) Estatura #2": "estatura_m",
    "custom (contact) Estatura #3": "estatura_m",
    "custom (contact) Estatura #4": "estatura_m",
    "custom (contact) Estatura #5": "estatura_m",
    "custom (contact) Estatura#1": "estatura_m",
    "custom (contact) IMC": "imc",
    "custom (contact) IMC#1": "imc",
    "custom (contact) Imc #1": "imc",
    "custom (contact) Imc #2": "imc",
    "custom (contact) Imc #3": "imc",
    "custom (contact) Imc #4": "imc",
    "custom (contact) Imc #5": "imc",
    "custom (contact) Tabaco": "tabaco",
    "custom (contact) Enfermedades cronicas": "enfermedades_cronicas",
    "custom (contact) Previsión": "prevision",
    "custom (contact) Previsión##": "prevision",
    "custom (contact) Previsión#1": "prevision",
    "custom (contact) Previsión###1": "prevision",
    "custom (contact) Tramo/Modalidad": "tramo_modalidad",
    "custom (contact) Ciudad": "ciudad",
    "custom (contact) Ciudad#1": "ciudad",
    "custom (contact) City#1": "ciudad",
    "custom (contact) City#2": "ciudad",
    "custom (contact) AGENTE": "agente",
    "custom (contact) Interés #1": "interes",
    "custom (contact) Fecha Ingresa Formulario": "fecha_ingresa_formulario",
    "custom (contact) Fecha Ingresa Formulario#1": "fecha_ingresa_formulario",
    "custom (contact) Etiquetas": "etiquetas_legacy",
    "custom (contact) Name#1": "name_alternativo",
}

# Lead CSV columns (79 total) → Frappe CRM Lead
LEAD_CSV_TO_FRAPPE = {
    # Standard
    "first_name": "first_name",
    "last_name": "last_name",
    "company_name": "organization_name",
    "owner": "_owner",
    # Custom
    "custom RUT o ID": "rut",
    "custom Edad": "edad",
    "custom Fecha Nacimiento": "fecha_nacimiento",
    "custom Peso": "peso_kg",
    "custom Peso #1": "peso_kg",
    "custom Peso #2": "peso_kg",
    "custom Peso #3": "peso_kg",
    "custom Estatura": "estatura_m",
    "custom Estatura #1": "estatura_m",
    "custom Estatura #2": "estatura_m",
    "custom IMC": "imc",
    "custom Imc #1": "imc",
    "custom Imc #2": "imc",
    "custom Tabaco": "tabaco",
    "custom Previsión": "prevision",
    "custom Interés": "interes",
    "custom Enfermedades cronicas": "enfermedades_cronicas",
    "custom Medicamentos cronicos": "enfermedades_cronicas",  # combina con cronicas
    "custom Ciudad": "ciudad",
    "custom AGENTE": "_agente",  # std field via lead_owner
    "custom Etiquetas": "_etiquetas",
    "custom Instagram": "_instagram",
    "custom Teléfono": "_phone_alt",
    "custom Mobile #1": "_mobile_alt",
}

# Deal CSV columns (99 total) → Frappe CRM Deal
DEAL_CSV_TO_FRAPPE = {
    "id": "_zendesk_id",
    "name": "_deal_name",
    "pipeline_id": "_pipeline_id",
    "pipeline_name": "_pipeline_name",
    "stage_name": "_stage_name",
    "stage_id": "_stage_id",
    "owner": "_owner",
    "main_contact_id": "_zendesk_contact_id",
    "main_contact": "_contact_name",
    "tags": "_tags",
    # Custom
    "custom RUT o ID": "rut",
    "custom RUT O ID": "rut",
    "custom RUT_normalizado": "rut_normalizado",
    "custom EDAD": "edad",
    "custom Fecha Nacimiento": "fecha_nacimiento",
    "custom Fecha de nacimiento": "fecha_nacimiento",
    "custom Peso": "peso_kg",
    "custom Estatura": "estatura_m",
    "custom PESO (metros)": "estatura_m",
    "custom IMC": "imc",
    "custom previsión": "prevision",
    "custom Previsión": "prevision",
    "custom PREVISION": "prevision",
    "custom Prevision": "prevision",
    "custom Tramo/Modalidad": "tramo_modalidad",
    "custom Validacion PAD": "validacion_pad",
    "custom CIRUGIAS PREVIAS": "_cirugias_previas",
    "custom Cirugías Previas": "_cirugias_previas",
    "custom COLELITIASIS": "colelitiasis",
    "custom BIOPSIA PENDIENTE": "biopsia_pendiente",
    "custom Interés": "interes",
    "custom CIRUGIA / PROCEDIMIENTO": "cirugia_procedimiento",
    "custom CIRUGIABARIATRICA": "cirugia_bariatrica_legacy",
    "custom CIRUJANO BARIÁTRICO": "cirujano_bariatrico",
    "custom CIRUJANO PLASTICO": "cirujano_plastico",
    "custom CIRUJANO GENERAL": "cirujano_general",
    "custom CIRUJANO DE BALON": "cirujano_balon",
    "custom 2DO CIRUJANO": "cirujano_2",
    "custom 3ER CIRUJANO": "cirujano_3",
    "custom ANESTESISTA": "anestesista",
    "custom ARSENALERA": "arsenalera",
    "custom SUCURSAL": "sucursal",
    "custom FECHA SOLICITUD DE PABELLON": "fecha_solicitud_pabellon",
    "custom FECHA DE CIRUGÍA": "fecha_cirugia",
    "custom PROGRAMA MÉDICO ENTREGADO": "programa_medico_entregado",
    "custom DOCUMENTACIÓN DE INGRESO": "documentacion_ingreso",
    "custom HONORARIOS": "honorarios",
    "custom fecha": "fecha_legacy",
    "custom Fecha Ingresa Formulario": "fecha_ingresa_formulario",
    "custom *Fecha Hito 1* (agregado el)": "fecha_hito_1",
    "custom * Fecha Hito 2* (Atención profesional)": "fecha_hito_2",
    "custom DIFF F.CIRUGIA-HITO2": "diff_cirugia_hito2",
    "custom URL-EXAMENES": "url_examenes",
    "custom URL-MEDINET": "url_medinet",
    "custom WhatsApp_Contactar_LINK": "whatsapp_contactar_link",
    "custom Numero familia paciente": "numero_familia_paciente",
    "custom OBSERVACIÓN": "observacion",
}

PIPELINE_NAME_TO_FRAPPE = {
    "Pipeline Cirugía Bariátricas": "Bariátrica",
    "Pipeline Balones": "Balón",
    "Pipeline Cirugía Plastica ": "Plástica",
    "Pipeline Cirugía Plastica": "Plástica",
    "Pipeline Cirugía General": "General",
}

VALID_PREVISION = {"BANMEDICA", "COLMENA", "CONSALUD", "CRUZ BLANCA", "CRUZ DEL NORTE",
                   "DIPRECA", "ESENCIAL", "FONASA", "FUNDACION", "I SALUD - EX CHUQUICAMATA",
                   "JEAFOSALE", "MEDIMEL-BANMEDICA", "NUEVA MAS VIDA", "OTRA DE FUERZAS ARMADAS",
                   "PAD Fonasa PAD", "PARTICULAR", "VIDA TRES"}

PREVISION_ALIASES = {
    "MEDIMEL (ESCONDIDA)": "MEDIMEL-BANMEDICA", "MEDIMEL": "MEDIMEL-BANMEDICA",
    "MEDIMEL ESCONDIDA": "MEDIMEL-BANMEDICA",
    "FFAA": "OTRA DE FUERZAS ARMADAS", "FUERZA ARMADA": "OTRA DE FUERZAS ARMADAS",
    "I.SALUD": "I SALUD - EX CHUQUICAMATA",
    "ISAPRE CRUZ BLANCA": "CRUZ BLANCA", "PARTICULAR/ISAPRE": "PARTICULAR",
    "VIDATRES": "VIDA TRES",
}

VALID_TRAMO = {"Tramo A", "Tramo B", "Tramo C", "Tramo D",
               "Banmédica", "Colmena", "Consalud", "Cruz Blanca", "Cruz Norte",
               "DIPRECA", "Fonasa", "Fuerza Armadas", "Fundación",
               "I. Chuquicamata", "MEDIMEL-CB", "Más Vida", "Particular"}

VALID_TABACO = {"No", "Sí", "Ex-fumador"}

VALID_COLELITIASIS = {"SI - Calculos en Ecografia", "NO - Ecografía sin Calculos", "COLECISTECTOMÍA PREVIA"}

VALID_BIOPSIA = {"NO SE TOMO BIOPSIA - OK", "BIOPSIA PENDIENTE - NO AGENDAR !!", "BIOPSIA TOMADA Y REVISADA OK"}

VALID_SUCURSAL = {"CLINCA BUPA ANTOFAGASTA", "CLINICA LA PORTADA ANTOFAGASTA", "SANTIAGO"}

VALID_CIRUGIA_PROCEDIMIENTO = {
    "MANGA", "BYPASS", "CONVERSIÓN MANGA-BYPASS", "ANTIRREFLUJO", "COLECISTECTOMÍA",
    "HERNIOPLASTIA INGUINAL", "HEMORROIDECTOMÍA", "HERNIOPLASTIA UMBILICAL",
    "HERNIOPLASTIA HIATAL", "ERCP", "FISTULA ANORECTAL", "APENDICECTOMÍA",
    "ABDOMINOPLASTIA", "OTRAS PLASTICAS", "INSTALACIÓN BALON ORBERA",
    "INSTALACIÓN BALON ALLURION", "RETIRO BALON ORBERA"
}

VALID_CIRUJANO_BARIATRICO = {"AUN NO LO DECIDE", "RODRIGO VILLAGRAN", "CRISTOBAL GUIXE",
                              "NASSER ELUZEN", "ALBERTO SIRABO", "ANDRES SAN MARTIN",
                              "CRISTOBAL DAVANZO", "JHOMAR YANSEN", "RAMON DIAZ",
                              "FRANCISCO BENČINA", "FRANCISCO RODRIGUEZ",
                              "AMALIA ZAPATA", "NELSON AROS"}

CIRUJANO_ALIASES = {
    "RODRIGO VILLAGRAN SANTIAGO": "RODRIGO VILLAGRAN",
    "Rodrigo Villagran Morales": "RODRIGO VILLAGRAN",
    "ALBERTO SIRABO SANTIAGO": "ALBERTO SIRABO",
    "ANDRES SAN MARTIN SANTIAGO": "ANDRES SAN MARTIN",
}

VALID_CIRUJANO_PLASTICO = {"FRANCISCO BENČINA", "EDMUNDO ZIEDE", "ROSIRYS RUIZ"}
VALID_CIRUJANO_GENERAL = {"SILVANA BINGHINOTTO", "CHRISTIAN ROMERO", "BRUNO SOLARI",
                           "CARLOS ARCE", "RODRIGO VILLAGRAN", "ALBERTO SIRABO", "NELSON AROS"}
VALID_CIRUJANO_BALON = {"RODRIGO VILLAGRAN", "NASSER ELUZEN", "ALBERTO SIRABO", "NELSON AROS"}

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def http(method, path, body=None, timeout=30, retries=4):
    data = json.dumps(body).encode() if body else None
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(f"{SITE}{path}", data=data, method=method,
            headers={"Authorization": AUTH, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            body_text = e.read().decode("utf-8", errors="replace")
            if e.code >= 500 and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            try: return e.code, json.loads(body_text)
            except: return e.code, {"_raw": body_text[:300]}
        except (TimeoutError, urllib.error.URLError, ConnectionError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            return 599, {"_raw": f"network: {type(e).__name__}: {str(e)[:80]}"}
    return 599, {"_raw": f"exhausted: {last}"}


def clean(v):
    if v is None: return None
    s = str(v).strip().replace("\t", " ").replace("\r", "").strip()
    return s or None


def parse_date(v):
    s = clean(v)
    if not s: return None
    if re.match(r"^\d{4}-\d{2}-\d{2}", s): return s[:10]
    m = re.match(r"^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$", s)
    if m:
        d, mo, y = m.groups()
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    return None


def parse_datetime(v):
    s = clean(v)
    if not s: return None
    if re.match(r"^\d{4}-\d{2}-\d{2}", s): return s.replace("T", " ").split(".")[0][:19]
    m = re.match(r"^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})(?:[T ](\d{1,2}):(\d{2}))?", s)
    if m:
        d, mo, y, h, mi = m.groups()
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)} {(h or '00').zfill(2)}:{(mi or '00').zfill(2)}:00"
    return None


def to_float(v):
    s = clean(v)
    if not s: return None
    try: return float(s.replace(",", "."))
    except: return None


def to_int(v):
    s = clean(v)
    if not s: return None
    try: return int(float(s.replace(",", ".")))
    except: return None


def normalize_estatura(v):
    n = to_float(v)
    if n is None: return None
    return round(n / 100, 2) if n > 10 else round(n, 2)


def normalize_phone(v):
    s = clean(v)
    if not s or "@" in s: return None
    s = re.sub(r"^(TELEFONO|TEL|TELÉFONO|FONO|MOVIL|CELULAR|PHONE):\s*", "", s, flags=re.IGNORECASE)
    s = s.replace("±", "+").replace("‪", "").replace("‬", "")
    s = re.sub(r"[^\d+\-\s\(\)]", "", s).strip()
    if len(re.sub(r"\D", "", s)) < 7: return None
    return s


def normalize_select(v, valid_set, aliases=None):
    s = clean(v)
    if not s: return None
    if s in valid_set: return s
    upper = s.upper()
    for x in valid_set:
        if x.upper() == upper: return x
    if aliases and (s in aliases or upper in aliases):
        return aliases.get(s) or aliases.get(upper)
    return None


def unify_ok_pendiente(value, field):
    s = clean(value)
    if not s: return None
    v = s.upper()
    if field == "validacion_pad":
        if "NO APLICA" in v or "TRAMO A" in v or v == "NO": return "NO APLICA"
        if v in ("SI", "OK"): return "OK"
        return "PENDIENTE"
    if v in ("SI", "LISTO", "OK"): return "OK"
    return "PENDIENTE"


def is_valid_rut(rut):
    if not rut: return False
    s = re.sub(r"[^0-9Kk]", "", str(rut).upper())
    return 7 <= len(s) <= 10 and bool(re.match(r"^\d+[0-9K]$", s))


# ─────────────────────────────────────────────────────────────────────────────
# Translation
# ─────────────────────────────────────────────────────────────────────────────

def translate_contact_csv(row):
    f = {"doctype": "Contact"}
    standard = {"first_name", "last_name"}
    ciudad_set = False

    for col, fname in CONTACT_CSV_TO_FRAPPE.items():
        v = row.get(col)
        if not v: continue
        v = clean(v)
        if not v: continue

        # Standard
        if fname == "_email":
            if "@" in v: f["email_ids"] = [{"email_id": v, "is_primary": 1}]
        elif fname == "_phone":
            p = normalize_phone(v)
            if p: f.setdefault("phone_nos", []).append({"phone": p, "is_primary_phone": 1})
        elif fname == "_mobile":
            p = normalize_phone(v)
            if p: f.setdefault("phone_nos", []).append({"phone": p, "is_primary_mobile_no": 1})
        elif fname == "_address":
            f["address_line1"] = v
        elif fname == "_tags":
            pass  # skip
        elif fname == "first_name":
            f["first_name"] = v
        elif fname == "last_name":
            f["last_name"] = v
        # Custom — only first non-empty wins (handle dups)
        elif fname not in f:
            if fname == "edad":
                f[fname] = to_int(v)
            elif fname in ("peso_kg", "imc"):
                f[fname] = to_float(v)
            elif fname == "estatura_m":
                f[fname] = normalize_estatura(v)
            elif fname == "fecha_nacimiento":
                d = parse_date(v)
                if d: f[fname] = d
            elif fname == "fecha_ingresa_formulario":
                d = parse_datetime(v)
                if d: f[fname] = d
            elif fname == "tabaco":
                tv = v.lower()
                mapped = "Sí" if tv in ("si", "sí", "yes", "true", "1") else ("No" if tv in ("no", "false", "0") else v)
                m = normalize_select(mapped, VALID_TABACO)
                if m: f[fname] = m
            elif fname == "prevision":
                m = normalize_select(v, VALID_PREVISION, PREVISION_ALIASES)
                if m: f[fname] = m
            elif fname == "tramo_modalidad":
                m = normalize_select(v, VALID_TRAMO)
                if m: f[fname] = m
            elif fname == "sucursal":
                m = normalize_select(v, VALID_SUCURSAL)
                if m: f[fname] = m
            elif fname == "colelitiasis":
                m = normalize_select(v, VALID_COLELITIASIS)
                if m: f[fname] = m
            elif fname == "biopsia_pendiente":
                m = normalize_select(v, VALID_BIOPSIA)
                if m: f[fname] = m
            elif fname == "ciudad" and not ciudad_set:
                f[fname] = v
                ciudad_set = True
            else:
                f[fname] = v

    return {k: v for k, v in f.items() if v is not None}


def translate_lead_csv(row):
    f = {"doctype": "CRM Lead"}
    for col, fname in LEAD_CSV_TO_FRAPPE.items():
        v = clean(row.get(col))
        if not v: continue
        if fname.startswith("_"): continue  # skip metadata
        if fname == "first_name": f["first_name"] = v
        elif fname == "last_name": f["last_name"] = v
        elif fname == "organization_name": f["organization_name"] = v
        elif fname not in f:
            if fname == "edad": f[fname] = to_int(v)
            elif fname in ("peso_kg", "imc"): f[fname] = to_float(v)
            elif fname == "estatura_m": f[fname] = normalize_estatura(v)
            elif fname == "fecha_nacimiento":
                d = parse_date(v)
                if d: f[fname] = d
            elif fname == "tabaco":
                tv = v.lower()
                mapped = "Sí" if tv in ("si", "sí", "yes", "true", "1") else ("No" if tv in ("no", "false", "0") else v)
                m = normalize_select(mapped, VALID_TABACO)
                if m: f[fname] = m
            elif fname == "prevision":
                m = normalize_select(v, VALID_PREVISION, PREVISION_ALIASES)
                if m: f[fname] = m
            else:
                f[fname] = v

    # Email/phone from _email/_phone metadata if present in standard cols
    em = clean(row.get("email"))
    if em and "@" in em: f["email"] = em
    ph = normalize_phone(row.get("phone") or row.get("custom Teléfono"))
    if ph: f["phone"] = ph
    mob = normalize_phone(row.get("mobile") or row.get("custom Mobile #1"))
    if mob: f["mobile_no"] = mob

    return {k: v for k, v in f.items() if v is not None}


def translate_deal_csv(row):
    f = {"doctype": "CRM Deal"}
    pipe = clean(row.get("pipeline_name"))
    if pipe:
        f["pipeline"] = PIPELINE_NAME_TO_FRAPPE.get(pipe.strip(), pipe)
    name = clean(row.get("name"))
    if name: f["lead_name"] = name

    for col, fname in DEAL_CSV_TO_FRAPPE.items():
        v = clean(row.get(col))
        if not v: continue
        if fname.startswith("_"): continue
        if fname not in f:
            if fname == "edad": f[fname] = to_int(v)
            elif fname in ("peso_kg", "imc", "honorarios", "diff_cirugia_hito2"):
                f[fname] = to_float(v)
            elif fname == "estatura_m":
                f[fname] = normalize_estatura(v)
            elif fname in ("fecha_nacimiento", "fecha_cirugia", "fecha_solicitud_pabellon",
                           "fecha_hito_1", "fecha_hito_2"):
                d = parse_date(v)
                if d: f[fname] = d
            elif fname in ("fecha_legacy", "fecha_ingresa_formulario"):
                d = parse_datetime(v)
                if d: f[fname] = d
            elif fname in ("programa_medico_entregado", "documentacion_ingreso", "validacion_pad"):
                m = unify_ok_pendiente(v, fname)
                if m: f[fname] = m
            elif fname == "prevision":
                m = normalize_select(v, VALID_PREVISION, PREVISION_ALIASES)
                if m: f[fname] = m
            elif fname == "tramo_modalidad":
                m = normalize_select(v, VALID_TRAMO)
                if m: f[fname] = m
            elif fname == "cirujano_bariatrico":
                m = normalize_select(v, VALID_CIRUJANO_BARIATRICO, CIRUJANO_ALIASES)
                if m: f[fname] = m
            elif fname == "cirujano_plastico":
                m = normalize_select(v, VALID_CIRUJANO_PLASTICO)
                if m: f[fname] = m
            elif fname == "cirujano_general":
                m = normalize_select(v, VALID_CIRUJANO_GENERAL)
                if m: f[fname] = m
            elif fname == "cirujano_balon":
                m = normalize_select(v, VALID_CIRUJANO_BALON)
                if m: f[fname] = m
            elif fname == "cirugia_procedimiento":
                m = normalize_select(v, VALID_CIRUGIA_PROCEDIMIENTO)
                if m: f[fname] = m
            elif fname == "sucursal":
                m = normalize_select(v, VALID_SUCURSAL)
                if m: f[fname] = m
            elif fname == "colelitiasis":
                m = normalize_select(v, VALID_COLELITIASIS)
                if m: f[fname] = m
            elif fname == "biopsia_pendiente":
                m = normalize_select(v, VALID_BIOPSIA)
                if m: f[fname] = m
            else:
                f[fname] = v

    return {k: v for k, v in f.items() if v is not None}


# ─────────────────────────────────────────────────────────────────────────────
# Frappe operations
# ─────────────────────────────────────────────────────────────────────────────

def find_contact_by_rut(rut):
    """Returns Frappe Contact name or None."""
    if not is_valid_rut(rut):
        return None
    filters = json.dumps([["rut_normalizado", "=", str(rut)]])
    code, data = http("GET", f"/api/method/frappe.client.get_list?doctype=Contact&filters={urllib.parse.quote(filters)}&fields={urllib.parse.quote(json.dumps(['name']))}&limit_page_length=1")
    if code == 200 and data.get("message"):
        return data["message"][0]["name"]
    return None


def insert_doc(payload):
    code, resp = http("POST", "/api/method/frappe.client.insert", {"doc": payload})
    if code in (200, 201):
        return "OK", resp.get("message", {}).get("name", "?")
    if "DuplicateEntry" in str(resp):
        return "DUP", "duplicate"
    return "ERR", str(resp.get("exception", resp))[:120]


def delete_all_of(doctype, batch=200):
    """Delete all records of a doctype."""
    deleted = 0
    while True:
        code, data = http("GET", f"/api/method/frappe.client.get_list?doctype={urllib.parse.quote(doctype)}&fields={urllib.parse.quote(json.dumps(['name']))}&limit_page_length={batch}")
        items = data.get("message", []) if code == 200 else []
        if not items:
            break
        for it in items:
            enc = urllib.parse.quote(str(it["name"]))
            http("DELETE", f"/api/resource/{urllib.parse.quote(doctype)}/{enc}")
            deleted += 1
        if len(items) < batch:
            break
    return deleted


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

TRANSLATORS = {
    "contacts": (translate_contact_csv, "Contact"),
    "leads": (translate_lead_csv, "CRM Lead"),
    "deals": (translate_deal_csv, "CRM Deal"),
}


def run(entity, csv_path, mode, dry_run, limit, start_row):
    translator, target_doctype = TRANSLATORS[entity]

    print(f"=== Import CSV {entity} ({mode}{' DRY' if dry_run else ''}) ===")

    if mode == "replace" and not dry_run:
        print(f"  Modo REPLACE: borrando todos los {target_doctype}...")
        deleted = delete_all_of(target_doctype)
        print(f"  Borrados: {deleted}")

    started = time.time()
    stats = Counter()
    processed = 0

    with open(csv_path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row_idx, row in enumerate(reader, 1):
            if row_idx <= start_row:
                continue
            if limit and processed >= limit:
                break

            try:
                doc = translator(row)
            except Exception as e:
                stats["translate_err"] += 1
                continue

            # For contacts in INSERT mode: skip if RUT already exists in Frappe
            if entity == "contacts" and mode == "insert" and not dry_run:
                rut = doc.get("rut_normalizado")
                if rut and is_valid_rut(rut):
                    existing = find_contact_by_rut(rut)
                    if existing:
                        stats["already_exists"] += 1
                        processed += 1
                        continue

            if dry_run:
                if processed < 3:
                    print(f"\n  [{processed+1}] row={row_idx}:")
                    for k, v in doc.items():
                        if v not in (None, "", []):
                            sv = str(v)[:60]
                            print(f"    {k}: {sv}")
            else:
                status, info = insert_doc(doc)
                stats[status] += 1
                if status == "ERR" and stats["ERR"] < 5:
                    print(f"  [row {row_idx}] ERR: {info}")

            processed += 1
            if processed > 0 and processed % 500 == 0:
                elapsed = time.time() - started
                rate = processed / elapsed if elapsed else 0
                print(f"  --- progress: {processed} rows in {elapsed:.0f}s ({rate:.1f}/s)")

    elapsed = time.time() - started
    print(f"\n=== Done ===")
    print(f"  Processed: {processed} in {elapsed:.0f}s")
    print(f"  Stats: {dict(stats)}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--entity", required=True, choices=["contacts", "leads", "deals"])
    p.add_argument("--csv", required=True)
    p.add_argument("--mode", choices=["insert", "replace"], default="insert")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--start-row", type=int, default=0)
    args = p.parse_args()

    if not (SITE and KEY and SECRET):
        sys.exit("FRAPPE_CLOUD_* env vars no seteadas")
    if not os.path.exists(args.csv):
        sys.exit(f"CSV no encontrado: {args.csv}")

    run(args.entity, args.csv, args.mode, args.dry_run, args.limit, args.start_row)


if __name__ == "__main__":
    main()
