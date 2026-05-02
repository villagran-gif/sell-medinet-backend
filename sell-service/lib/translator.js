/**
 * Field translator: Zendesk Sell ↔ Frappe CRM.
 *
 * Zendesk Sell expone custom fields como objeto plano `custom_fields` con
 * keys = nombre del field ("RUT o ID", "Previsión", etc).
 *
 * Frappe expone custom fields como propiedades top-level del doc con fieldname
 * snake_case (rut, prevision, etc).
 *
 * Este módulo convierte en ambas direcciones, agrupando duplicados Zendesk
 * (Edad #1-#5, Estatura ×7, Previsión x4) en su versión canonical Frappe.
 *
 * Source of truth: migration/frappe-schema.json sección custom_fields.
 *
 * Para mantener simplicidad: la tabla CONTACT_FIELD_MAP / DEAL_FIELD_MAP
 * está hardcodeada acá. Si schema cambia hay que editar ambos lados.
 */

// =============================================================================
// CONTACT — Zendesk → Frappe Contact
// =============================================================================

/**
 * Mapeo: Zendesk custom_fields key → Frappe Contact fieldname
 * Para campos con duplicados, todas las versiones mapean al mismo target.
 * Migration write picks the most-recent non-empty value.
 */
export const CONTACT_TO_FRAPPE = {
  // Identidad chilena
  "RUT o ID": "rut",
  "RUT o ID#1": "rut",
  RUT_normalizado: "rut_normalizado",
  "RUT_normalizado#1": "rut_normalizado",

  // Edad / Fechas
  Edad: "edad",
  "Edad #1": "edad",
  "Edad #2": "edad",
  "Edad #3": "edad",
  "Edad #4": "edad",
  "Edad #5": "edad",
  "Fecha Nacimiento": "fecha_nacimiento",
  "Fecha Nacimiento#1": "fecha_nacimiento",

  // Antropométricos
  Peso: "peso_kg",
  "Peso #1": "peso_kg",
  "Peso #2": "peso_kg",
  "Peso #3": "peso_kg",
  "Peso #4": "peso_kg",
  "Peso#1": "peso_kg",
  Estatura: "estatura_m",
  "Estatura #1": "estatura_m",
  "Estatura #2": "estatura_m",
  "Estatura #3": "estatura_m",
  "Estatura #4": "estatura_m",
  "Estatura #5": "estatura_m",
  "Estatura#1": "estatura_m",
  IMC: "imc",
  "IMC#1": "imc",
  "Imc #1": "imc",
  "Imc #2": "imc",
  "Imc #3": "imc",
  "Imc #4": "imc",
  "Imc #5": "imc",

  // Médico
  Tabaco: "tabaco",
  "Enfermedades cronicas": "enfermedades_cronicas",
  // cirugias_previas eliminado de Contact (decisión 4)

  // Insurance
  "Previsión": "prevision",
  "Previsión##": "prevision",
  "Previsión#1": "prevision",
  "Previsión###1": "prevision",
  "Tramo/Modalidad": "tramo_modalidad",

  // Contact
  Ciudad: "ciudad",
  "Ciudad#1": "ciudad",
  "City#1": "ciudad",
  "City#2": "ciudad",

  // Internal
  AGENTE: "agente",
  "Interés #1": "interes",
  "Fecha Ingresa Formulario": "fecha_ingresa_formulario",
  "Fecha Ingresa Formulario#1": "fecha_ingresa_formulario",
  "Fecha ingresa formulario #1": "fecha_ingresa_formulario",
  "Fecha ingresa formulario #2": "fecha_ingresa_formulario",
  "Fecha ingresa formulario #3": "fecha_ingresa_formulario",
  "Fecha ingresa formulario #4": "fecha_ingresa_formulario",
  "Fecha ingresa formulario #5": "fecha_ingresa_formulario",
  Etiquetas: "etiquetas_legacy",
  "Name#1": "name_alternativo",
};

/**
 * Reverse: Frappe Contact fieldname → Zendesk canonical name (para responses)
 * Solo el "primary" name por field (no las versiones #1, #2 etc).
 */
export const CONTACT_FROM_FRAPPE = {
  rut: "RUT o ID",
  rut_normalizado: "RUT_normalizado",
  edad: "Edad",
  fecha_nacimiento: "Fecha Nacimiento",
  peso_kg: "Peso",
  estatura_m: "Estatura",
  imc: "IMC",
  tabaco: "Tabaco",
  enfermedades_cronicas: "Enfermedades cronicas",
  prevision: "Previsión",
  tramo_modalidad: "Tramo/Modalidad",
  ciudad: "Ciudad",
  agente: "AGENTE",
  interes: "Interés #1",
  fecha_ingresa_formulario: "Fecha Ingresa Formulario",
  etiquetas_legacy: "Etiquetas",
  name_alternativo: "Name#1",
};

// =============================================================================
// DEAL — Zendesk → Frappe CRM Deal
// =============================================================================

export const DEAL_TO_FRAPPE = {
  // Identidad (replicada de Contact via fetch_from en Frappe)
  "RUT o ID": "rut",
  "RUT O ID": "rut",
  RUT_normalizado: "rut_normalizado",
  EDAD: "edad",
  "Fecha Nacimiento": "fecha_nacimiento",
  "Fecha de nacimiento": "fecha_nacimiento",

  // Antropométricos (replicados)
  Peso: "peso_kg",
  Estatura: "estatura_m",
  "PESO (metros)": "estatura_m", // típico bug Zendesk: esto es altura, no peso
  IMC: "imc",

  // Insurance
  "previsión": "prevision",
  "Previsión": "prevision",
  PREVISION: "prevision",
  Prevision: "prevision",
  "Tramo/Modalidad": "tramo_modalidad",
  "Validacion PAD": "validacion_pad",

  // Médico
  "CIRUGIAS PREVIAS": "cirugias_previas", // child table — handled apart
  "Cirugías Previas": "cirugias_previas",
  COLELITIASIS: "colelitiasis",
  "BIOPSIA PENDIENTE": "biopsia_pendiente",
  Interés: "interes",

  // Cirugía
  "CIRUGIA / PROCEDIMIENTO": "cirugia_procedimiento",
  CIRUGIABARIATRICA: "cirugia_bariatrica_legacy",
  "CIRUJANO BARIÁTRICO": "cirujano_bariatrico",
  "CIRUJANO PLASTICO": "cirujano_plastico",
  "CIRUJANO GENERAL": "cirujano_general",
  "CIRUJANO DE BALON": "cirujano_balon",
  "2DO CIRUJANO": "cirujano_2",
  "3ER CIRUJANO": "cirujano_3",
  ANESTESISTA: "anestesista",
  ARSENALERA: "arsenalera",
  SUCURSAL: "sucursal",
  "FECHA SOLICITUD DE PABELLON": "fecha_solicitud_pabellon",
  "FECHA DE CIRUGÍA": "fecha_cirugia",
  "PROGRAMA MÉDICO ENTREGADO": "programa_medico_entregado",
  "DOCUMENTACIÓN DE INGRESO": "documentacion_ingreso",
  HONORARIOS: "honorarios",

  // Hitos
  fecha: "fecha_legacy",
  "Fecha Ingresa Formulario": "fecha_ingresa_formulario",
  "*Fecha Hito 1* (agregado el)": "fecha_hito_1",
  "* Fecha Hito 2* (Atención profesional)": "fecha_hito_2",
  "DIFF F.CIRUGIA-HITO2": "diff_cirugia_hito2",

  // External
  "URL-EXAMENES": "url_examenes",
  "URL-MEDINET": "url_medinet",
  WhatsApp_Contactar_LINK: "whatsapp_contactar_link",

  // Comisiones (child table — handled apart)
  ComisionBAR1: "_comision_bar_1",
  ComisionBAR2: "_comision_bar_2",
  ComisionBAR3: "_comision_bar_3",
  ComisionBAR4: "_comision_bar_4",
  ComisionBAR5: "_comision_bar_5",
  ComisionBAR6: "_comision_bar_6",

  // Colaboradores (child table — handled apart, 4 pipelines x N positions)
  "Colaborador 1 (BAR)": "_col_bar_1",
  "Colaborador 3 (BAR)": "_col_bar_3",
  "Colaborador 1 (PLASTICA)": "_col_plastica_1",
  "Colaborador 2 (PLASTICA)": "_col_plastica_2",
  "Colaborador 1 (GENERAL)": "_col_general_1",
  "Colaborador 2 (GENERAL)": "_col_general_2",
  "Colaborador 1. (BALON)": "_col_balon_1",
  "Colaborador 2 (BALON)": "_col_balon_2",

  // Other
  "Numero familia paciente": "numero_familia_paciente",
  "OBSERVACIÓN": "observacion",
};

export const DEAL_FROM_FRAPPE = {
  rut: "RUT o ID",
  rut_normalizado: "RUT_normalizado",
  edad: "EDAD",
  fecha_nacimiento: "Fecha Nacimiento",
  peso_kg: "Peso",
  estatura_m: "Estatura",
  imc: "IMC",
  prevision: "Previsión",
  tramo_modalidad: "Tramo/Modalidad",
  validacion_pad: "Validacion PAD",
  colelitiasis: "COLELITIASIS",
  biopsia_pendiente: "BIOPSIA PENDIENTE",
  interes: "Interés",
  cirugia_procedimiento: "CIRUGIA / PROCEDIMIENTO",
  cirugia_bariatrica_legacy: "CIRUGIABARIATRICA",
  cirujano_bariatrico: "CIRUJANO BARIÁTRICO",
  cirujano_plastico: "CIRUJANO PLASTICO",
  cirujano_general: "CIRUJANO GENERAL",
  cirujano_balon: "CIRUJANO DE BALON",
  cirujano_2: "2DO CIRUJANO",
  cirujano_3: "3ER CIRUJANO",
  anestesista: "ANESTESISTA",
  arsenalera: "ARSENALERA",
  sucursal: "SUCURSAL",
  fecha_solicitud_pabellon: "FECHA SOLICITUD DE PABELLON",
  fecha_cirugia: "FECHA DE CIRUGÍA",
  programa_medico_entregado: "PROGRAMA MÉDICO ENTREGADO",
  documentacion_ingreso: "DOCUMENTACIÓN DE INGRESO",
  honorarios: "HONORARIOS",
  fecha_legacy: "fecha",
  fecha_ingresa_formulario: "Fecha Ingresa Formulario",
  fecha_hito_1: "*Fecha Hito 1* (agregado el)",
  fecha_hito_2: "* Fecha Hito 2* (Atención profesional)",
  diff_cirugia_hito2: "DIFF F.CIRUGIA-HITO2",
  url_examenes: "URL-EXAMENES",
  url_medinet: "URL-MEDINET",
  whatsapp_contactar_link: "WhatsApp_Contactar_LINK",
  numero_familia_paciente: "Numero familia paciente",
  observacion: "OBSERVACIÓN",
};

// =============================================================================
// PIPELINE ID ↔ NAME (preservar IDs Zendesk para compat)
// =============================================================================

export const PIPELINE_ZENDESK_TO_FRAPPE = {
  1290779: "Bariátrica",
  4823817: "Balón",
  4959507: "Plástica",
  5049979: "General",
};

export const PIPELINE_FRAPPE_TO_ZENDESK = {
  "Bariátrica": 1290779,
  "Balón": 4823817,
  "Plástica": 4959507,
  "General": 5049979,
};

// =============================================================================
// Boolean / Select unified mappings (decisión 5)
// =============================================================================

/**
 * Map Zendesk valores legacy a OK/PENDIENTE para programa_medico, doc_ingreso, validacion_pad.
 * Migration: SI/LISTO → OK; NO/PENDIENTE → PENDIENTE (excepto validacion_pad que tiene NO APLICA).
 */
export function unifyOkPendiente(value, fieldType) {
  if (!value) return null;
  const v = String(value).trim().toUpperCase();

  // validacion_pad tiene 3 estados (decisión 7)
  if (fieldType === "validacion_pad") {
    if (v === "NO" || v.includes("NO APLICA") || v.includes("TRAMO A")) return "NO APLICA";
    if (v === "SI" || v === "OK") return "OK";
    return "PENDIENTE"; // PENDIENTE, "Posible evaluación", default
  }

  // programa_medico, documentacion_ingreso → 2 estados
  if (v === "SI" || v === "LISTO" || v === "OK") return "OK";
  return "PENDIENTE";
}

// =============================================================================
// Bidirectional translation entry points
// =============================================================================

/**
 * Convert Zendesk Sell-shaped contact to Frappe-shaped doc.
 * @param {object} zContact - { custom_fields: {...}, first_name, ... }
 * @returns {object} Frappe Contact doc (without doctype)
 */
export function contactZendeskToFrappe(zContact) {
  const f = {};
  // Standard fields (1:1)
  if (zContact.first_name) f.first_name = zContact.first_name;
  if (zContact.last_name) f.last_name = zContact.last_name;
  if (zContact.name && !f.first_name) f.first_name = zContact.name;
  if (zContact.email) f.email_id = zContact.email;
  if (zContact.phone) f.phone = zContact.phone;
  if (zContact.mobile) f.mobile_no = zContact.mobile;

  // Custom fields slot → flat
  const cf = zContact.custom_fields || {};
  for (const [zKey, value] of Object.entries(cf)) {
    if (value === null || value === undefined || value === "") continue;
    const fField = CONTACT_TO_FRAPPE[zKey];
    if (fField) {
      // Only overwrite if not already set (first non-empty wins to handle dups)
      if (f[fField] == null) f[fField] = value;
    }
  }
  return f;
}

/**
 * Convert Frappe Contact doc to Zendesk Sell-shaped response.
 */
export function contactFrappeToZendesk(fContact) {
  const customFields = {};
  for (const [fField, zKey] of Object.entries(CONTACT_FROM_FRAPPE)) {
    if (fContact[fField] != null && fContact[fField] !== "") {
      customFields[zKey] = fContact[fField];
    }
  }
  return {
    id: fContact.name,
    first_name: fContact.first_name,
    last_name: fContact.last_name,
    name: [fContact.first_name, fContact.last_name].filter(Boolean).join(" "),
    email: fContact.email_id,
    phone: fContact.phone,
    mobile: fContact.mobile_no,
    custom_fields: customFields,
    created_at: fContact.creation,
    updated_at: fContact.modified,
  };
}

/**
 * Idem para Deal.
 */
export function dealZendeskToFrappe(zDeal) {
  const f = {};
  if (zDeal.name) f.lead_name = zDeal.name;
  if (zDeal.value != null) f.deal_value = zDeal.value;
  if (zDeal.currency) f.currency = zDeal.currency;
  if (zDeal.stage_id) f.status = String(zDeal.stage_id); // map stage_id → status name (TODO)
  if (zDeal.contact_id) f.contact = String(zDeal.contact_id);
  if (zDeal.owner_id) f.deal_owner = String(zDeal.owner_id);
  if (zDeal.estimated_close_date) f.expected_closure_date = zDeal.estimated_close_date;
  if (zDeal.pipeline_id) {
    f.pipeline = PIPELINE_ZENDESK_TO_FRAPPE[zDeal.pipeline_id] || null;
  }

  const cf = zDeal.custom_fields || {};
  for (const [zKey, value] of Object.entries(cf)) {
    if (value === null || value === undefined) continue;

    // Bug fix heredado: ZAP update-comisiones escribe '' en FECHA DE CIRUGÍA
    if (zKey === "FECHA DE CIRUGÍA" && value === "") continue;

    const fField = DEAL_TO_FRAPPE[zKey];
    if (!fField) continue;

    // Skip child table fields here (manejados apart)
    if (fField.startsWith("_")) continue;

    // Apply unification for OK/PENDIENTE fields
    let val = value;
    if (
      ["programa_medico_entregado", "documentacion_ingreso", "validacion_pad"].includes(
        fField
      )
    ) {
      val = unifyOkPendiente(value, fField);
    }

    if (f[fField] == null) f[fField] = val;
  }

  // TODO: child tables comisiones + colaboradores from ComisionBAR1-6 + Colaborador*

  return f;
}

export function dealFrappeToZendesk(fDeal) {
  const customFields = {};
  for (const [fField, zKey] of Object.entries(DEAL_FROM_FRAPPE)) {
    if (fDeal[fField] != null && fDeal[fField] !== "") {
      customFields[zKey] = fDeal[fField];
    }
  }
  return {
    id: fDeal.name,
    name: fDeal.lead_name || fDeal.organization_name,
    value: fDeal.deal_value,
    currency: fDeal.currency || "CLP",
    stage_id: fDeal.status, // TODO: map status name → numeric id
    pipeline_id: PIPELINE_FRAPPE_TO_ZENDESK[fDeal.pipeline] || null,
    contact_id: fDeal.contact,
    owner_id: fDeal.deal_owner,
    estimated_close_date: fDeal.expected_closure_date,
    hot: false,
    custom_fields: customFields,
    created_at: fDeal.creation,
    updated_at: fDeal.modified,
  };
}
