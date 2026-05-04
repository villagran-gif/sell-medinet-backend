#!/usr/bin/env python3
"""
Configura layouts del CRM Deal:
  - Data Fields tab: organiza ~70 fields en 9 secciones logicas
  - Side Panel: Contactos, Colaboradores, Tareas, Documentos

Se basa en la UI de Zendesk Sell que el usuario quiere replicar.
Idempotente: re-correr sobreescribe.
"""
import json, os, sys, urllib.request, urllib.parse, urllib.error

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


def section(name, label, *col_fields):
    """Build a section with N columns of fields."""
    return {
        "name": name,
        "label": label,
        "editable": False,
        "columns": [
            {"name": f"col_{name}_{i}", "fields": list(fields)}
            for i, fields in enumerate(col_fields)
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# DATA FIELDS layout (center "Datos" tab)
# 3 columnas por seccion para densidad
# ─────────────────────────────────────────────────────────────────────────────
DATA_LAYOUT = [
    section("paciente", "Información del paciente",
        ["rut_normalizado", "prevision", "edad"],
        ["tramo_modalidad", "sucursal", "interes"],
        ["pipeline_name", "lead_name", "rut"],
    ),
    section("estado", "Estado del deal",
        ["status", "probability", "deal_value"],
        ["deal_owner", "currency", "expected_closure_date"],
        ["closed_date", "lost_reason", "source"],
    ),
    section("cirugia", "Cirugía / Procedimiento",
        ["cirugia_procedimiento", "fecha_cirugia", "fecha_solicitud_pabellon"],
        ["cirujano_bariatrico", "cirujano_plastico", "cirujano_general"],
        ["cirujano_balon", "cirujano_2", "cirujano_3"],
    ),
    section("equipo", "Equipo médico",
        ["anestesista", "arsenalera"],
        ["honorarios"],
        ["numero_familia_paciente"],
    ),
    section("medico", "Datos médicos",
        ["peso_kg", "estatura_m", "imc"],
        ["colelitiasis", "biopsia_pendiente", "validacion_pad"],
        ["fecha_nacimiento", "fecha_ingresa_formulario"],
    ),
    section("hitos", "Hitos & seguimiento",
        ["fecha_hito_1", "fecha_hito_2", "diff_cirugia_hito2"],
        ["programa_medico_entregado", "documentacion_ingreso"],
        ["fecha_legacy"],
    ),
    section("links", "Documentos & links",
        ["url_medinet", "url_examenes"],
        ["whatsapp_contactar_link"],
        ["observacion"],
    ),
    section("zendesk_meta", "Zendesk metadata",
        ["zendesk_id_deal", "zendesk_id_main_contact"],
        ["zd_owner", "zd_creator"],
        ["zd_created_at", "zd_updated_at", "zd_last_activity_date"],
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# SIDE PANEL layout (right side: contactos, colaboradores, etc.)
# ─────────────────────────────────────────────────────────────────────────────
SIDE_LAYOUT = [
    section("contactos", "Contactos",
        ["contact", "contacts"],
    ),
    section("info_clave", "Info clave",
        ["rut_normalizado", "prevision", "tramo_modalidad"],
    ),
    section("operacional", "Operacional",
        ["sucursal", "cirugia_procedimiento", "fecha_cirugia"],
    ),
    section("agente_y_owner", "Asignación",
        ["deal_owner", "status", "pipeline_name"],
    ),
    section("perdida", "Razón de la pérdida",
        ["lost_reason"],
    ),
]


def update_layout(name, layout):
    body = {"layout": json.dumps(layout, ensure_ascii=False)}
    code, resp = http("PUT", f"/api/resource/CRM%20Fields%20Layout/{urllib.parse.quote(name, safe='')}", body)
    if code in (200, 202):
        print(f"  OK  {name}")
    else:
        print(f"  ERR {name}: {code}  {resp}")


def main():
    if not (SITE and KEY and SECRET): sys.exit("env")
    print("Updating CRM Deal layouts...")
    update_layout("CRM Deal-Data Fields", DATA_LAYOUT)
    update_layout("CRM Deal-Side Panel", SIDE_LAYOUT)


if __name__ == "__main__":
    main()
