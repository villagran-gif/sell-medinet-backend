/**
 * Meta endpoints: pipelines, stages, custom_fields, users, sources.
 *
 * Estos son los endpoints "read-only" más usados por box-ai-clinyco
 * y similares para popular dropdowns en sus UIs.
 *
 * Estrategia: emular la respuesta exacta de Zendesk Sell v2 leyendo
 * data desde Frappe Cloud.
 */

import { Router } from "express";
import { frappe } from "../lib/frappe-client.js";
import {
  PIPELINE_FRAPPE_TO_ZENDESK,
  PIPELINE_ZENDESK_TO_FRAPPE,
  CONTACT_FROM_FRAPPE,
  DEAL_FROM_FRAPPE,
} from "../lib/translator.js";

const router = Router();

// Wrapping helper para format Zendesk { items: [ {data: ...}, ... ] }
function asZendeskList(items) {
  return {
    items: items.map((d) => ({ data: d, meta: { type: typeof d } })),
    meta: { type: "collection", count: items.length },
  };
}

// =============================================================================
// GET /v2/pipelines
// =============================================================================

router.get("/pipelines", async (_req, res, next) => {
  try {
    // Pipelines no están en Frappe como entity — son inferred desde
    // CRM Deal Status + el custom field 'pipeline' en CRM Deal.
    // Devolvemos los 4 hardcoded con sus IDs Zendesk.
    const items = [
      { id: 1290779, name: "Pipeline Cirugía Bariátricas", disabled: false, _frappe: "Bariátrica" },
      { id: 4823817, name: "Pipeline Balones", disabled: false, _frappe: "Balón" },
      { id: 4959507, name: "Pipeline Cirugía Plastica ", disabled: false, _frappe: "Plástica" },
      { id: 5049979, name: "Pipeline Cirugía General", disabled: false, _frappe: "General" },
    ];
    res.json(asZendeskList(items));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /v2/stages
// =============================================================================

router.get("/stages", async (req, res, next) => {
  try {
    const pipelineId = req.query.pipeline_id ? Number(req.query.pipeline_id) : null;

    // Mapeo Zendesk-style stages a partir de CRM Deal Status (8 statuses globales)
    // Cada pipeline expone los mismos 8 stages, con IDs sintéticos para compat.
    // Zendesk asignaba stages diferentes por pipeline; Frappe unifica statuses.
    const STATUS_TEMPLATE = [
      { name: "Candidato", category: "incoming", position: 1 },
      { name: "Examenes Solicitados", category: "in_progress", position: 2 },
      { name: "Examenes Recibidos", category: "in_progress", position: 3 },
      { name: "Pre-Operatorio", category: "in_progress", position: 4 },
      { name: "Cerrado Agendado", category: "in_progress", position: 5 },
      { name: "Cerrado Operado", category: "won", position: 6 },
      { name: "Suspendido", category: "unqualified", position: 7 },
      { name: "Sin Respuesta", category: "lost", position: 8 },
    ];

    const allPipelines = pipelineId
      ? [pipelineId]
      : Object.values(PIPELINE_FRAPPE_TO_ZENDESK);

    const items = [];
    let stageId = 1;
    for (const pid of allPipelines) {
      for (const tpl of STATUS_TEMPLATE) {
        items.push({
          id: pid * 100 + tpl.position, // synthetic but stable per (pipeline, position)
          name: tpl.name,
          category: tpl.category,
          position: tpl.position,
          pipeline_id: pid,
          active: true,
          likelihood: tpl.category === "won" ? 100 : tpl.category === "lost" ? 0 : 50,
        });
      }
    }

    res.json(asZendeskList(items));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /v2/contact/custom_fields
// GET /v2/deal/custom_fields
// GET /v2/lead/custom_fields
// =============================================================================

function customFieldsResponse(fromFrappeMap) {
  // Generate Zendesk-style custom_field defs from our reverse map.
  // Each entry: { id, name, type, settings, ... }
  const items = Object.entries(fromFrappeMap).map(([fField, zName], idx) => ({
    id: idx + 1, // synthetic; Zendesk used numeric IDs
    name: zName,
    type: "string", // best-effort — could refine per fieldname
    settings: { editable: true, mandatory: false },
  }));
  return asZendeskList(items);
}

router.get("/contact/custom_fields", (_req, res) => {
  res.json(customFieldsResponse(CONTACT_FROM_FRAPPE));
});

router.get("/deal/custom_fields", (_req, res) => {
  res.json(customFieldsResponse(DEAL_FROM_FRAPPE));
});

router.get("/lead/custom_fields", (_req, res) => {
  // Lead in Zendesk had 0 custom fields; mantener vacío
  res.json(asZendeskList([]));
});

// =============================================================================
// GET /v2/users
// =============================================================================

router.get("/users", async (_req, res, next) => {
  try {
    const users = await frappe.getList("User", {
      filters: [["enabled", "=", 1]],
      fields: ["name", "full_name", "email", "username", "first_name", "last_name"],
      limit: 100,
    });
    const items = users
      .filter((u) => u.name !== "Administrator" && u.name !== "Guest")
      .map((u, idx) => ({
        id: idx + 1, // synthetic Zendesk-shaped id
        email: u.email || u.name,
        name: u.full_name || u.name,
        first_name: u.first_name,
        last_name: u.last_name,
        confirmed: true,
        status: "active",
      }));
    res.json(asZendeskList(items));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /v2/lead_sources
// GET /v2/deal_sources
// =============================================================================

router.get("/lead_sources", async (_req, res, next) => {
  try {
    const sources = await frappe.getList("CRM Lead Source", {
      filters: [["is_for_lead", "=", 1]],
      fields: ["name", "source_name"],
      limit: 100,
    });
    const items = sources.map((s, idx) => ({
      id: idx + 1,
      name: s.source_name || s.name,
      resource_type: "lead",
    }));
    res.json(asZendeskList(items));
  } catch (err) {
    next(err);
  }
});

router.get("/deal_sources", async (_req, res, next) => {
  try {
    const sources = await frappe.getList("CRM Lead Source", {
      filters: [["is_for_deal", "=", 1]],
      fields: ["name", "source_name"],
      limit: 100,
    });
    const items = sources.map((s, idx) => ({
      id: idx + 1,
      name: s.source_name || s.name,
      resource_type: "deal",
    }));
    res.json(asZendeskList(items));
  } catch (err) {
    next(err);
  }
});

export default router;
