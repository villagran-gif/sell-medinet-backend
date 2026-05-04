#!/usr/bin/env python3
"""
Configura layouts del CRM Deal para que se parezca a Zendesk Sell:

ZENDESK Sell tiene:
  - Panel IZQUIERDO: stack vertical de ~50 fields, single-column
  - Panel CENTRO: feed cronologico de actividad (notas, eventos)
  - Panel DERECHO: Contactos asociados, Colaboradores, Tareas, Documentos

FCRM mapea:
  - Side Panel (derecha) = panel izquierdo de Zendesk → todos los fields
  - Tabs centro (Actividad, Notas, etc) = panel centro de Zendesk
  - Linked records (en side panel sections) = panel derecho de Zendesk

Order de fields exacto de la lista que paso el usuario.
Idempotente.
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


def section(name, label, *col_fields, hidden=False):
    return {
        "name": name,
        "label": label,
        "editable": False,
        "hidden": hidden,
        "columns": [
            {"name": f"col_{name}_{i}", "fields": list(fields)}
            for i, fields in enumerate(col_fields)
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# SIDE PANEL (derecha) — replica Zendesk left panel: todos los fields en orden
# Single column. ~50 fields agrupados en sections collapsibles.
# ─────────────────────────────────────────────────────────────────────────────
SIDE_LAYOUT = [
    section("contactos", "Contactos asociados",
        ["contact"],
    ),
    section("identificacion", "Identificación",
        ["rut_normalizado", "rut", "deal_owner", "tramo_modalidad",
         "prevision", "edad"],
    ),
    section("estado", "Estado",
        ["status", "pipeline_name", "probability",
         "expected_closure_date", "deal_value", "lost_reason"],
    ),
    section("operacional", "Operacional",
        ["sucursal", "cirugia_procedimiento", "fecha_cirugia",
         "fecha_solicitud_pabellon"],
    ),
    section("cirujanos", "Equipo médico",
        ["cirujano_bariatrico", "cirujano_plastico", "cirujano_general",
         "cirujano_balon", "cirujano_2", "cirujano_3",
         "anestesista", "arsenalera", "honorarios"],
    ),
    section("medico", "Datos médicos",
        ["peso_kg", "estatura_m", "imc", "fecha_nacimiento",
         "colelitiasis", "biopsia_pendiente", "validacion_pad",
         "interes"],
    ),
    section("hitos", "Hitos & seguimiento",
        ["fecha_hito_1", "fecha_hito_2", "diff_cirugia_hito2",
         "fecha_ingresa_formulario", "fecha_legacy",
         "programa_medico_entregado", "documentacion_ingreso"],
    ),
    section("links_doc", "Links",
        ["url_medinet", "url_examenes", "whatsapp_contactar_link"],
    ),
    section("colaboradores_bar", "Colaboradores BAR",
        ["zd_custom_colaborador_1_bar", "zd_custom_colaborador_3_bar"],
    ),
    section("comisiones", "Comisiones",
        ["zd_custom_comisionbar1", "zd_custom_comisionbar2",
         "zd_custom_comisionbar3", "zd_custom_comisionbar4",
         "zd_custom_comisionbar5", "zd_custom_comisionbar6"],
    ),
    section("notas_obs", "Observaciones",
        ["observacion", "numero_familia_paciente"],
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# DATA FIELDS (tab Datos) — mismo contenido pero en 2 columnas para edicion
# rapida tipo formulario.
# ─────────────────────────────────────────────────────────────────────────────
DATA_LAYOUT = [
    section("paciente", "Paciente",
        ["rut_normalizado", "prevision", "tramo_modalidad"],
        ["edad", "deal_owner", "interes"],
    ),
    section("estado", "Estado del deal",
        ["status", "pipeline_name", "probability"],
        ["deal_value", "expected_closure_date", "lost_reason"],
    ),
    section("cirugia", "Cirugía",
        ["cirugia_procedimiento", "fecha_cirugia", "fecha_solicitud_pabellon"],
        ["sucursal", "validacion_pad", "biopsia_pendiente"],
    ),
    section("equipo", "Equipo médico",
        ["cirujano_bariatrico", "cirujano_plastico", "cirujano_general"],
        ["cirujano_balon", "cirujano_2", "cirujano_3"],
    ),
    section("equipo_extra", "Equipo extra",
        ["anestesista", "arsenalera"],
        ["honorarios", "numero_familia_paciente"],
    ),
    section("medico", "Datos médicos",
        ["peso_kg", "estatura_m", "imc"],
        ["colelitiasis", "fecha_nacimiento"],
    ),
    section("hitos", "Hitos",
        ["fecha_hito_1", "fecha_hito_2", "diff_cirugia_hito2"],
        ["fecha_ingresa_formulario", "programa_medico_entregado", "documentacion_ingreso"],
    ),
    section("links", "Links",
        ["url_medinet", "url_examenes"],
        ["whatsapp_contactar_link"],
    ),
    section("colaboradores", "Colaboradores",
        ["zd_custom_colaborador_1_bar", "zd_custom_colaborador_3_bar"],
        [],
    ),
    section("comisiones", "Comisiones BAR",
        ["zd_custom_comisionbar1", "zd_custom_comisionbar2", "zd_custom_comisionbar3"],
        ["zd_custom_comisionbar4", "zd_custom_comisionbar5", "zd_custom_comisionbar6"],
    ),
    section("observacion", "Observación",
        ["observacion"],
        [],
    ),
]


def update_layout(name, layout):
    body = {"layout": json.dumps(layout, ensure_ascii=False)}
    code, resp = http("PUT", f"/api/resource/CRM%20Fields%20Layout/{urllib.parse.quote(name, safe='')}", body)
    print(f"  {'OK ' if code in (200,202) else f'ERR {code}'}  {name}")
    if code not in (200,202):
        print(f"    {resp}")


def main():
    if not (SITE and KEY and SECRET): sys.exit("env")
    print("Updating CRM Deal layouts...")
    update_layout("CRM Deal-Data Fields", DATA_LAYOUT)
    update_layout("CRM Deal-Side Panel", SIDE_LAYOUT)


if __name__ == "__main__":
    main()
