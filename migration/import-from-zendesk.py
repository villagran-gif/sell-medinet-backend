#!/usr/bin/env python3
"""
Importa records desde Zendesk Sell → Frappe Cloud CRM.

Uso:
  # Dry-run: solo muestra los primeros 10 records traducidos sin insertar
  python3 migration/import-from-zendesk.py --entity contacts --dry-run --limit 10

  # Full import contacts
  python3 migration/import-from-zendesk.py --entity contacts

  # Resume desde página específica
  python3 migration/import-from-zendesk.py --entity deals --start-page 50

  # Limit count
  python3 migration/import-from-zendesk.py --entity leads --limit 100

Env vars requeridas:
  ZENDESK_SELL_API_TOKEN   - Token Zendesk Sell
  FRAPPE_CLOUD_SITE_URL    - https://clinyco.frappe.cloud
  FRAPPE_CLOUD_API_KEY     - Frappe API key
  FRAPPE_CLOUD_API_SECRET  - Frappe API secret

Comportamiento:
  - Idempotente: skip records que ya existen en Frappe (por external_id o email)
  - Logs progreso cada 50 records
  - Errores van a stderr, continúa con siguientes
  - Rate limit: 5 req/sec contra Frappe (configurable)
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error
import urllib.parse
from collections import Counter

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

ZENDESK_TOKEN = os.environ.get("ZENDESK_SELL_API_TOKEN", "")
FRAPPE_URL = os.environ.get("FRAPPE_CLOUD_SITE_URL", "").rstrip("/")
FRAPPE_KEY = os.environ.get("FRAPPE_CLOUD_API_KEY", "")
FRAPPE_SECRET = os.environ.get("FRAPPE_CLOUD_API_SECRET", "")

ZENDESK_BASE = "https://api.getbase.com/v2"
FRAPPE_AUTH = f"token {FRAPPE_KEY}:{FRAPPE_SECRET}"

# Rate limit: max requests per second to each backend
ZENDESK_RPS = 10  # ~600/min, well under 700 limit
FRAPPE_RPS = 5

# ─────────────────────────────────────────────────────────────────────────────
# Field maps (mirror translator.js)
# ─────────────────────────────────────────────────────────────────────────────

CONTACT_TO_FRAPPE = {
    "RUT o ID": "rut", "RUT o ID#1": "rut",
    "RUT_normalizado": "rut_normalizado", "RUT_normalizado#1": "rut_normalizado",
    "Edad": "edad", "Edad #1": "edad", "Edad #2": "edad", "Edad #3": "edad",
    "Edad #4": "edad", "Edad #5": "edad",
    "Fecha Nacimiento": "fecha_nacimiento", "Fecha Nacimiento#1": "fecha_nacimiento",
    "Peso": "peso_kg", "Peso #1": "peso_kg", "Peso #2": "peso_kg",
    "Peso #3": "peso_kg", "Peso #4": "peso_kg", "Peso#1": "peso_kg",
    "Estatura": "estatura_m", "Estatura #1": "estatura_m", "Estatura #2": "estatura_m",
    "Estatura #3": "estatura_m", "Estatura #4": "estatura_m", "Estatura #5": "estatura_m",
    "Estatura#1": "estatura_m",
    "IMC": "imc", "IMC#1": "imc",
    "Imc #1": "imc", "Imc #2": "imc", "Imc #3": "imc", "Imc #4": "imc", "Imc #5": "imc",
    "Tabaco": "tabaco",
    "Enfermedades cronicas": "enfermedades_cronicas",
    "Previsión": "prevision", "Previsión##": "prevision",
    "Previsión#1": "prevision", "Previsión###1": "prevision",
    "Tramo/Modalidad": "tramo_modalidad",
    "Ciudad": "ciudad", "Ciudad#1": "ciudad", "City#1": "ciudad", "City#2": "ciudad",
    "AGENTE": "agente",
    "Interés #1": "interes",
    "Fecha Ingresa Formulario": "fecha_ingresa_formulario",
    "Fecha Ingresa Formulario#1": "fecha_ingresa_formulario",
    "Fecha ingresa formulario #1": "fecha_ingresa_formulario",
    "Fecha ingresa formulario #2": "fecha_ingresa_formulario",
    "Fecha ingresa formulario #3": "fecha_ingresa_formulario",
    "Fecha ingresa formulario #4": "fecha_ingresa_formulario",
    "Fecha ingresa formulario #5": "fecha_ingresa_formulario",
    "Etiquetas": "etiquetas_legacy",
    "Name#1": "name_alternativo",
}

DEAL_TO_FRAPPE = {
    "RUT o ID": "rut", "RUT O ID": "rut",
    "RUT_normalizado": "rut_normalizado",
    "EDAD": "edad",
    "Fecha Nacimiento": "fecha_nacimiento", "Fecha de nacimiento": "fecha_nacimiento",
    "Peso": "peso_kg", "Estatura": "estatura_m",
    "PESO (metros)": "estatura_m",  # bug histórico, esto es altura
    "IMC": "imc",
    "previsión": "prevision", "Previsión": "prevision",
    "PREVISION": "prevision", "Prevision": "prevision",
    "Tramo/Modalidad": "tramo_modalidad",
    "Validacion PAD": "validacion_pad",
    "COLELITIASIS": "colelitiasis",
    "BIOPSIA PENDIENTE": "biopsia_pendiente",
    "Interés": "interes",
    "CIRUGIA / PROCEDIMIENTO": "cirugia_procedimiento",
    "CIRUGIABARIATRICA": "cirugia_bariatrica_legacy",
    "CIRUJANO BARIÁTRICO": "cirujano_bariatrico",
    "CIRUJANO PLASTICO": "cirujano_plastico",
    "CIRUJANO GENERAL": "cirujano_general",
    "CIRUJANO DE BALON": "cirujano_balon",
    "2DO CIRUJANO": "cirujano_2",
    "3ER CIRUJANO": "cirujano_3",
    "ANESTESISTA": "anestesista",
    "ARSENALERA": "arsenalera",
    "SUCURSAL": "sucursal",
    "FECHA SOLICITUD DE PABELLON": "fecha_solicitud_pabellon",
    "FECHA DE CIRUGÍA": "fecha_cirugia",
    "PROGRAMA MÉDICO ENTREGADO": "programa_medico_entregado",
    "DOCUMENTACIÓN DE INGRESO": "documentacion_ingreso",
    "HONORARIOS": "honorarios",
    "fecha": "fecha_legacy",
    "Fecha Ingresa Formulario": "fecha_ingresa_formulario",
    "*Fecha Hito 1* (agregado el)": "fecha_hito_1",
    "* Fecha Hito 2* (Atención profesional)": "fecha_hito_2",
    "DIFF F.CIRUGIA-HITO2": "diff_cirugia_hito2",
    "URL-EXAMENES": "url_examenes",
    "URL-MEDINET": "url_medinet",
    "WhatsApp_Contactar_LINK": "whatsapp_contactar_link",
    "Numero familia paciente": "numero_familia_paciente",
    "OBSERVACIÓN": "observacion",
}

# Lead in Zendesk Sell didn't have custom fields, but Frappe Lead has 11 medical
LEAD_CUSTOM_TO_FRAPPE = {
    "RUT o ID": "rut", "RUT_normalizado": "rut_normalizado",
    "Edad": "edad", "Fecha Nacimiento": "fecha_nacimiento",
    "Peso": "peso_kg", "Estatura": "estatura_m", "IMC": "imc",
    "Tabaco": "tabaco", "Previsión": "prevision",
    "Interés": "interes", "Enfermedades cronicas": "enfermedades_cronicas",
}

PIPELINE_ID_TO_FRAPPE = {
    1290779: "Bariátrica",
    4823817: "Balón",
    4959507: "Plástica",
    5049979: "General",
}

# Valid Select choices — para skip values que no matchean
VALID_PREVISION = {"BANMEDICA", "COLMENA", "CONSALUD", "CRUZ BLANCA", "CRUZ DEL NORTE",
                   "DIPRECA", "ESENCIAL", "FONASA", "FUNDACION", "I SALUD - EX CHUQUICAMATA",
                   "JEAFOSALE", "MEDIMEL-BANMEDICA", "NUEVA MAS VIDA", "OTRA DE FUERZAS ARMADAS",
                   "PAD Fonasa PAD", "PARTICULAR", "VIDA TRES"}

# Mapeo de variantes legacy → canonical
PREVISION_ALIASES = {
    "MEDIMEL (ESCONDIDA)": "MEDIMEL-BANMEDICA",
    "MEDIMEL": "MEDIMEL-BANMEDICA",
    "MEDIMEL ESCONDIDA": "MEDIMEL-BANMEDICA",
    "FFAA": "OTRA DE FUERZAS ARMADAS",
    "FUERZA ARMADA": "OTRA DE FUERZAS ARMADAS",
    "I.SALUD": "I SALUD - EX CHUQUICAMATA",
    "ISAPRE CRUZ BLANCA": "CRUZ BLANCA",
    "PARTICULAR/ISAPRE": "PARTICULAR",
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

# Cirujano name normalizations (unifica RODRIGO VILLAGRAN SANTIAGO → RODRIGO VILLAGRAN, etc)
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


def normalize_select(value, valid_set, aliases=None):
    """Returns the value if it (or alias) is in valid_set, else None."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Direct match
    if s in valid_set:
        return s
    # Try uppercase comparison (case-insensitive against the set)
    upper = s.upper()
    for v in valid_set:
        if v.upper() == upper:
            return v
    # Try alias
    if aliases:
        if s in aliases:
            return aliases[s]
        if upper in aliases:
            return aliases[upper]
    return None  # caller should skip the field

# ─────────────────────────────────────────────────────────────────────────────
# HTTP helpers
# ─────────────────────────────────────────────────────────────────────────────

class RateLimiter:
    def __init__(self, rps):
        self.interval = 1.0 / rps
        self.last = 0

    def wait(self):
        now = time.time()
        elapsed = now - self.last
        if elapsed < self.interval:
            time.sleep(self.interval - elapsed)
        self.last = time.time()


zendesk_rl = RateLimiter(ZENDESK_RPS)
frappe_rl = RateLimiter(FRAPPE_RPS)


def http(method, url, headers=None, body=None, timeout=30, max_retries=4):
    """HTTP con retry exponencial para errores de red (timeout, connection reset, 5xx)."""
    data = json.dumps(body).encode() if body else None

    last_err = None
    for attempt in range(max_retries):
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            body_text = e.read().decode("utf-8", errors="replace")
            # 5xx → retry; 4xx → bubble up immediately
            if e.code >= 500 and attempt < max_retries - 1:
                last_err = e
                wait = 2 ** attempt
                print(f"    [retry {attempt+1}/{max_retries}] HTTP {e.code}, waiting {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            try:
                return e.code, json.loads(body_text)
            except json.JSONDecodeError:
                return e.code, {"_raw": body_text[:300]}
        except (TimeoutError, urllib.error.URLError, ConnectionError) as e:
            last_err = e
            if attempt < max_retries - 1:
                wait = 2 ** attempt
                print(f"    [retry {attempt+1}/{max_retries}] {type(e).__name__}, waiting {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            # Out of retries — return synthetic error
            return 599, {"_raw": f"network: {type(e).__name__}: {str(e)[:100]}"}
    return 599, {"_raw": f"exhausted retries: {last_err}"}


def zendesk_get(path):
    zendesk_rl.wait()
    return http(
        "GET", f"{ZENDESK_BASE}{path}",
        headers={"Authorization": f"Bearer {ZENDESK_TOKEN}"},
    )


def frappe_post(path, body):
    frappe_rl.wait()
    return http(
        "POST", f"{FRAPPE_URL}{path}",
        headers={"Authorization": FRAPPE_AUTH, "Content-Type": "application/json"},
        body=body,
    )


def frappe_get(path):
    frappe_rl.wait()
    return http("GET", f"{FRAPPE_URL}{path}",
                headers={"Authorization": FRAPPE_AUTH})


# ─────────────────────────────────────────────────────────────────────────────
# Translation
# ─────────────────────────────────────────────────────────────────────────────

def normalize_estatura(v):
    """Si v > 10 → cm, dividir entre 100. Si ≤ 10 → ya en metros."""
    if v is None or v == "":
        return None
    try:
        n = float(str(v).replace(",", "."))
        if n > 10:
            return round(n / 100, 2)
        return round(n, 2)
    except (ValueError, TypeError):
        return None


def to_float(v):
    if v is None or v == "":
        return None
    try:
        return float(str(v).strip().replace(",", "."))
    except (ValueError, TypeError):
        return None


def parse_date(v):
    """Acepta DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD; devuelve YYYY-MM-DD o None."""
    if v is None or v == "":
        return None
    s = str(v).strip()
    if not s:
        return None
    # Already YYYY-MM-DD
    import re
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        return s
    # DD/MM/YYYY or DD-MM-YYYY
    m = re.match(r"^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$", s)
    if m:
        d, mo, y = m.groups()
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    return None  # unrecognized


def parse_datetime(v):
    """Acepta varios formatos datetime; devuelve YYYY-MM-DD HH:MM:SS o None."""
    if v is None or v == "":
        return None
    s = str(v).strip()
    if not s:
        return None
    import re
    # Already ISO-ish
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s.replace("T", " ").split(".")[0][:19]
    # DD/MM/YYYY HH:MM
    m = re.match(r"^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})(?:[T ](\d{1,2}):(\d{2}))?", s)
    if m:
        d, mo, y, h, mi = m.groups()
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)} {(h or '00').zfill(2)}:{(mi or '00').zfill(2)}:00"
    return None


def clean_str(v):
    """Strip whitespace incluyendo tabs/newlines internos."""
    if v is None:
        return None
    return str(v).strip().replace("\t", " ").replace("\r", "").strip() or None


def normalize_phone(v):
    """Limpia teléfono: strip 'TELEFONO:' prefix, unicode ± → +, valida formato.
    Returns formatted phone or None if invalid."""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    # Strip common prefixes
    import re
    s = re.sub(r"^(TELEFONO|TEL|TELÉFONO|FONO|MOVIL|CELULAR|PHONE):\s*", "", s, flags=re.IGNORECASE)
    # Replace unicode ± and similar to +
    s = s.replace("±", "+").replace("‪", "").replace("‬", "")
    # Reject if looks like email
    if "@" in s:
        return None
    # Keep only digits, +, spaces, dashes, parens
    s = re.sub(r"[^\d+\-\s\(\)]", "", s).strip()
    # Must have at least 7 digits
    digits = re.sub(r"\D", "", s)
    if len(digits) < 7:
        return None
    return s


def to_int(v):
    if v is None or v == "":
        return None
    try:
        return int(float(str(v).replace(",", ".")))
    except (ValueError, TypeError):
        return None


def unify_ok_pendiente(value, field_type):
    """Map Zendesk values to OK/PENDIENTE (or NO APLICA for validacion_pad)."""
    if value is None or value == "":
        return None
    v = str(value).strip().upper()
    if field_type == "validacion_pad":
        if "NO APLICA" in v or "TRAMO A" in v:
            return "NO APLICA"
        if v in ("NO",):
            return "NO APLICA"
        if v in ("SI", "OK"):
            return "OK"
        return "PENDIENTE"
    # programa_medico, documentacion_ingreso
    if v in ("SI", "LISTO", "OK"):
        return "OK"
    return "PENDIENTE"


def translate_contact(z_contact):
    """Zendesk Contact → Frappe Contact dict."""
    f = {"doctype": "Contact"}
    if z_contact.get("first_name"):
        f["first_name"] = z_contact["first_name"]
    if z_contact.get("last_name"):
        f["last_name"] = z_contact["last_name"]
    if z_contact.get("email"):
        # Validate email format minimally
        em = clean_str(z_contact["email"])
        if em and "@" in em:
            f["email_ids"] = [{"email_id": em, "is_primary": 1}]
    p = normalize_phone(z_contact.get("phone"))
    if p:
        f["phone_nos"] = [{"phone": p, "is_primary_phone": 1}]
    m = normalize_phone(z_contact.get("mobile"))
    if m:
        f.setdefault("phone_nos", []).append({"phone": m, "is_primary_mobile_no": 1})

    cf = z_contact.get("custom_fields") or {}
    for z_key, f_field in CONTACT_TO_FRAPPE.items():
        v = cf.get(z_key)
        if v is None or v == "":
            continue
        # Don't overwrite if already set (first non-empty wins)
        if f_field in f and f[f_field]:
            continue
        # Type coercion
        if f_field == "edad":
            f[f_field] = to_int(v)
        elif f_field in ("peso_kg", "imc"):
            f[f_field] = to_float(v)
        elif f_field == "estatura_m":
            f[f_field] = normalize_estatura(v)
        elif f_field == "fecha_nacimiento":
            d = parse_date(v)
            if d:
                f[f_field] = d
        elif f_field == "fecha_ingresa_formulario":
            dt = parse_datetime(v)
            if dt:
                f[f_field] = dt
        elif f_field == "tabaco":
            tv = clean_str(v) or ""
            mapped = "Sí" if tv.lower() in ("si", "sí", "yes", "true", "1") else ("No" if tv.lower() in ("no", "false", "0") else tv)
            f[f_field] = normalize_select(mapped, VALID_TABACO)  # may be None if invalid
        elif f_field == "prevision":
            f[f_field] = normalize_select(clean_str(v), VALID_PREVISION, PREVISION_ALIASES)
        elif f_field == "tramo_modalidad":
            f[f_field] = normalize_select(clean_str(v), VALID_TRAMO)
        else:
            f[f_field] = clean_str(v)

    # Save Zendesk ID for traceability (not standard field — could put in description)
    if z_contact.get("id"):
        f["_zendesk_id"] = z_contact["id"]
    # Drop None values
    return {k: v for k, v in f.items() if v is not None}


def translate_deal(z_deal):
    """Zendesk Deal → Frappe CRM Deal dict."""
    f = {"doctype": "CRM Deal"}
    if z_deal.get("name"):
        f["lead_name"] = z_deal["name"]
    if z_deal.get("value") is not None:
        f["deal_value"] = z_deal["value"]
    if z_deal.get("currency"):
        f["currency"] = z_deal["currency"]
    if z_deal.get("estimated_close_date"):
        f["expected_closure_date"] = z_deal["estimated_close_date"]
    if z_deal.get("pipeline_id"):
        f["pipeline"] = PIPELINE_ID_TO_FRAPPE.get(z_deal["pipeline_id"])

    cf = z_deal.get("custom_fields") or {}
    comisiones = []
    colaboradores = []

    for z_key, value in cf.items():
        if value is None or value == "":
            continue
        # Bug fix: ZAP escribe "" en FECHA DE CIRUGÍA
        if z_key == "FECHA DE CIRUGÍA" and value == "":
            continue

        # Comisiones: ComisionBAR1-6
        if z_key.startswith("ComisionBAR"):
            try:
                # Take only the code (8001/5002/etc), not the alt index
                comisiones.append({"codigo": str(value).strip()})
            except Exception:
                pass
            continue

        # Colaboradores
        if z_key.startswith("Colaborador"):
            try:
                first_name = str(value).strip().split()[0]
                colaboradores.append({"colaborador": first_name})
            except Exception:
                pass
            continue

        f_field = DEAL_TO_FRAPPE.get(z_key)
        if not f_field:
            continue

        # Type coercion
        if f_field == "edad":
            f[f_field] = to_int(value)
        elif f_field in ("peso_kg", "imc", "honorarios", "diff_cirugia_hito2"):
            f[f_field] = to_float(value)
        elif f_field == "estatura_m":
            f[f_field] = normalize_estatura(value)
        elif f_field in ("fecha_nacimiento", "fecha_cirugia", "fecha_solicitud_pabellon",
                         "fecha_hito_1", "fecha_hito_2"):
            d = parse_date(value)
            if d:
                f[f_field] = d
        elif f_field in ("fecha_legacy", "fecha_ingresa_formulario"):
            dt = parse_datetime(value)
            if dt:
                f[f_field] = dt
        elif f_field in ("programa_medico_entregado", "documentacion_ingreso", "validacion_pad"):
            f[f_field] = unify_ok_pendiente(value, f_field)
        elif f_field == "prevision":
            f[f_field] = normalize_select(clean_str(value), VALID_PREVISION, PREVISION_ALIASES)
        elif f_field == "tramo_modalidad":
            f[f_field] = normalize_select(clean_str(value), VALID_TRAMO)
        elif f_field == "colelitiasis":
            f[f_field] = normalize_select(clean_str(value), VALID_COLELITIASIS)
        elif f_field == "biopsia_pendiente":
            f[f_field] = normalize_select(clean_str(value), VALID_BIOPSIA)
        elif f_field == "sucursal":
            f[f_field] = normalize_select(clean_str(value), VALID_SUCURSAL)
        elif f_field == "cirugia_procedimiento":
            f[f_field] = normalize_select(clean_str(value), VALID_CIRUGIA_PROCEDIMIENTO)
        elif f_field == "cirujano_bariatrico":
            f[f_field] = normalize_select(clean_str(value), VALID_CIRUJANO_BARIATRICO, CIRUJANO_ALIASES)
        elif f_field == "cirujano_plastico":
            f[f_field] = normalize_select(clean_str(value), VALID_CIRUJANO_PLASTICO)
        elif f_field == "cirujano_general":
            f[f_field] = normalize_select(clean_str(value), VALID_CIRUJANO_GENERAL)
        elif f_field == "cirujano_balon":
            f[f_field] = normalize_select(clean_str(value), VALID_CIRUJANO_BALON)
        else:
            f[f_field] = clean_str(value)

    if comisiones:
        f["comisiones"] = comisiones
    if colaboradores:
        f["colaboradores"] = colaboradores

    if z_deal.get("id"):
        f["_zendesk_id"] = z_deal["id"]
    return {k: v for k, v in f.items() if v is not None}


def translate_lead(z_lead):
    """Zendesk Lead → Frappe CRM Lead dict."""
    f = {"doctype": "CRM Lead"}
    if z_lead.get("first_name"):
        f["first_name"] = z_lead["first_name"]
    if z_lead.get("last_name"):
        f["last_name"] = z_lead["last_name"]
    em = clean_str(z_lead.get("email"))
    if em and "@" in em:
        f["email"] = em
    p = normalize_phone(z_lead.get("phone"))
    if p:
        f["phone"] = p
    m = normalize_phone(z_lead.get("mobile"))
    if m:
        f["mobile_no"] = m
    if z_lead.get("organization_name"):
        f["organization_name"] = z_lead["organization_name"]
    if z_lead.get("title"):
        f["job_title"] = z_lead["title"]
    if z_lead.get("description"):
        f["description"] = z_lead["description"]

    cf = z_lead.get("custom_fields") or {}
    for z_key, f_field in LEAD_CUSTOM_TO_FRAPPE.items():
        v = cf.get(z_key)
        if v is None or v == "":
            continue
        if f_field == "edad":
            f[f_field] = to_int(v)
        elif f_field in ("peso_kg", "imc"):
            f[f_field] = to_float(v)
        elif f_field == "estatura_m":
            f[f_field] = normalize_estatura(v)
        elif f_field == "fecha_nacimiento":
            d = parse_date(v)
            if d:
                f[f_field] = d
        else:
            f[f_field] = clean_str(v)

    if z_lead.get("id"):
        f["_zendesk_id"] = z_lead["id"]
    return {k: v for k, v in f.items() if v is not None}


# ─────────────────────────────────────────────────────────────────────────────
# Main processing
# ─────────────────────────────────────────────────────────────────────────────

def fetch_page(entity, page, per_page=100):
    code, data = zendesk_get(f"/{entity}?per_page={per_page}&page={page}")
    if code != 200:
        return []
    return [it.get("data", {}) for it in data.get("items", [])]


def insert_frappe(doctype, doc):
    """Insert into Frappe, return (status, message_or_error)."""
    # Strip our internal _zendesk_id field — not in Frappe schema
    payload = {k: v for k, v in doc.items() if not k.startswith("_")}
    code, resp = frappe_post("/api/method/frappe.client.insert", {"doc": payload})
    if code in (200, 201):
        return "OK", resp.get("message", {}).get("name", "?")
    if code == 409 or "DuplicateEntry" in str(resp):
        return "DUP", "duplicate"
    err = str(resp.get("exception", resp))[:150]
    return "ERR", err


def run(entity, dry_run, limit, start_page, per_page=100, verbose=False):
    print(f"=== Migración {entity} {'(DRY RUN)' if dry_run else '(LIVE)'} ===")
    print(f"  start_page={start_page}, limit={limit}, per_page={per_page}")

    translator = {"contacts": translate_contact, "deals": translate_deal, "leads": translate_lead}[entity]
    target_doctype = {"contacts": "Contact", "deals": "CRM Deal", "leads": "CRM Lead"}[entity]

    stats = Counter()
    page = start_page
    processed = 0
    started_at = time.time()

    while True:
        records = fetch_page(entity, page, per_page)
        if not records:
            print(f"  page {page}: empty, done")
            break

        for z in records:
            if limit and processed >= limit:
                break
            try:
                f_doc = translator(z)
            except Exception as e:
                stats["translate_err"] += 1
                print(f"    [page {page} z_id={z.get('id')}] translate err: {e}", file=sys.stderr)
                continue

            if dry_run:
                print(f"\n  [{processed+1}] z_id={z.get('id')} → {target_doctype}:")
                # Compact print (skip empty)
                for k, v in f_doc.items():
                    if v not in (None, "", []):
                        if isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
                            print(f"    {k}: {len(v)} items → {v[:1]}")
                        else:
                            sv = str(v)[:60]
                            print(f"    {k}: {sv}")
            else:
                status, info = insert_frappe(target_doctype, f_doc)
                stats[status] += 1
                if verbose or status == "ERR":
                    print(f"  [page {page} #{processed+1} z_id={z.get('id')}] {status}: {info}")

            processed += 1

        if limit and processed >= limit:
            break
        if len(records) < per_page:
            break
        page += 1
        if processed > 0 and processed % 200 == 0:
            elapsed = time.time() - started_at
            rate = processed / elapsed if elapsed > 0 else 0
            print(f"  --- progress: {processed} records in {elapsed:.1f}s ({rate:.1f}/s); last_page={page}")

    elapsed = time.time() - started_at
    rate = processed / elapsed if elapsed > 0 else 0
    print(f"\n=== Done ===")
    print(f"  Total processed: {processed} in {elapsed:.1f}s ({rate:.1f}/s)")
    print(f"  Stats: {dict(stats)}")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--entity", required=True, choices=["contacts", "deals", "leads"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0, help="0=no limit")
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--per-page", type=int, default=100)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if not ZENDESK_TOKEN:
        sys.exit("ZENDESK_SELL_API_TOKEN no seteado")
    if not (FRAPPE_URL and FRAPPE_KEY and FRAPPE_SECRET):
        sys.exit("FRAPPE_CLOUD_* env vars no seteadas")

    run(args.entity, args.dry_run, args.limit, args.start_page, args.per_page, args.verbose)


if __name__ == "__main__":
    main()
