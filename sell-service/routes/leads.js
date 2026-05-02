/**
 * /v2/leads — CRUD compatible con Zendesk Sell.
 *
 * Zendesk Lead no tiene custom fields → mapeo simple solo standard fields.
 * Frappe CRM Lead sí tiene 11 campos médicos custom (rut, edad, peso, etc).
 */

import { Router } from "express";
import { frappe } from "../lib/frappe-client.js";

const router = Router();

function asZendeskItem(d) {
  return { data: d, meta: { type: "lead" } };
}
function asZendeskList(items) {
  return {
    items: items.map((d) => ({ data: d, meta: { type: "lead" } })),
    meta: { type: "collection", count: items.length },
  };
}

// Lead doesn't use custom_fields slot (Zendesk Sell never had them for leads)
// All fields are top-level in both Zendesk and Frappe responses
const ZENDESK_LEAD_TO_FRAPPE = {
  first_name: "first_name",
  last_name: "last_name",
  organization_name: "organization_name",
  title: "job_title",
  email: "email",
  phone: "phone",
  mobile: "mobile_no",
  description: "description",
  website: "website",
  industry: "industry",
  // Note: status/source mapping requires Frappe Lead Status / CRM Lead Source resolution
};

const FRAPPE_LEAD_TO_ZENDESK = Object.fromEntries(
  Object.entries(ZENDESK_LEAD_TO_FRAPPE).map(([z, f]) => [f, z])
);

function leadZendeskToFrappe(zLead) {
  const f = {};
  for (const [zKey, fKey] of Object.entries(ZENDESK_LEAD_TO_FRAPPE)) {
    if (zLead[zKey] != null) f[fKey] = zLead[zKey];
  }
  // Custom fields chilenos pueden venir top-level (Zendesk no los tenía pero por
  // compat futuro) o dentro de un slot custom_fields legacy
  const cf = zLead.custom_fields || {};
  const customMap = {
    "RUT o ID": "rut",
    RUT_normalizado: "rut_normalizado",
    Edad: "edad",
    "Fecha Nacimiento": "fecha_nacimiento",
    Peso: "peso_kg",
    Estatura: "estatura_m",
    IMC: "imc",
    Tabaco: "tabaco",
    "Previsión": "prevision",
    "Interés": "interes",
    "Enfermedades cronicas": "enfermedades_cronicas",
  };
  for (const [zk, fk] of Object.entries(customMap)) {
    if (cf[zk]) f[fk] = cf[zk];
    if (zLead[fk]) f[fk] = zLead[fk]; // also accept top-level
  }
  return f;
}

function leadFrappeToZendesk(fLead) {
  const z = {
    id: fLead.name,
    first_name: fLead.first_name,
    last_name: fLead.last_name,
    organization_name: fLead.organization_name,
    title: fLead.job_title,
    email: fLead.email,
    phone: fLead.phone,
    mobile: fLead.mobile_no,
    description: fLead.description,
    website: fLead.website,
    industry: fLead.industry,
    status: fLead.status,
    custom_fields: {},
    created_at: fLead.creation,
    updated_at: fLead.modified,
  };
  // Push custom fields chilenos al slot custom_fields para compat con Zendesk shape
  const customMap = {
    rut: "RUT o ID",
    rut_normalizado: "RUT_normalizado",
    edad: "Edad",
    fecha_nacimiento: "Fecha Nacimiento",
    peso_kg: "Peso",
    estatura_m: "Estatura",
    imc: "IMC",
    tabaco: "Tabaco",
    prevision: "Previsión",
    interes: "Interés",
    enfermedades_cronicas: "Enfermedades cronicas",
  };
  for (const [fk, zk] of Object.entries(customMap)) {
    if (fLead[fk] != null && fLead[fk] !== "") z.custom_fields[zk] = fLead[fk];
  }
  return z;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v2/leads/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const f = await frappe.getDoc("CRM Lead", req.params.id);
    if (!f) {
      return res.status(404).json({
        errors: [{ resource: "leads", code: "not_found" }],
      });
    }
    res.json(asZendeskItem(leadFrappeToZendesk(f)));
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({
        errors: [{ resource: "leads", code: "not_found", message: err.message }],
      });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v2/leads?ids=
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const idsParam = req.query.ids;
    const perPage = Math.min(Number(req.query.per_page) || 25, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);

    let leads = [];
    if (idsParam) {
      const ids = String(idsParam).split(",").filter(Boolean);
      for (const id of ids) {
        try {
          const l = await frappe.getDoc("CRM Lead", id);
          if (l) leads.push(l);
        } catch {}
      }
    } else {
      const list = await frappe.getList("CRM Lead", {
        fields: ["name"],
        limit: perPage,
        page,
      });
      for (const l of list) {
        try {
          leads.push(await frappe.getDoc("CRM Lead", l.name));
        } catch {}
      }
    }
    res.json(asZendeskList(leads.map(leadFrappeToZendesk)));
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v2/leads
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const zLead = req.body?.data || req.body;
    if (!zLead || typeof zLead !== "object") {
      return res.status(400).json({
        errors: [{ resource: "leads", code: "invalid_body" }],
      });
    }
    const fDoc = leadZendeskToFrappe(zLead);
    if (!fDoc.first_name && !fDoc.last_name) {
      return res.status(400).json({
        errors: [{ resource: "leads", code: "missing_name", message: "first_name or last_name required" }],
      });
    }
    const created = await frappe.insert("CRM Lead", fDoc);
    res.status(201).json(asZendeskItem(leadFrappeToZendesk(created)));
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /v2/leads/:id
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
  try {
    const zLead = req.body?.data || req.body;
    const fDoc = leadZendeskToFrappe(zLead);
    const updated = await frappe.update("CRM Lead", req.params.id, fDoc);
    res.json(asZendeskItem(leadFrappeToZendesk(updated)));
  } catch (err) {
    next(err);
  }
});

export default router;
