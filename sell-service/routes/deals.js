/**
 * /v2/deals — CRUD compatible con Zendesk Sell.
 *
 * Manejo especial de child tables Zendesk → Frappe:
 *   - ComisionBAR1-6 → child table `comisiones`
 *   - Colaborador * (BAR/PLASTICA/GENERAL/BALON) → child table `colaboradores`
 */

import { Router } from "express";
import { frappe } from "../lib/frappe-client.js";
import {
  dealZendeskToFrappe,
  dealFrappeToZendesk,
} from "../lib/translator.js";

const router = Router();

function asZendeskItem(d) {
  return { data: d, meta: { type: "deal" } };
}
function asZendeskList(items) {
  return {
    items: items.map((d) => ({ data: d, meta: { type: "deal" } })),
    meta: { type: "collection", count: items.length },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v2/deals/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const fDeal = await frappe.getDoc("CRM Deal", req.params.id);
    if (!fDeal) {
      return res.status(404).json({
        errors: [{ resource: "deals", code: "not_found" }],
      });
    }
    res.json(asZendeskItem(dealFrappeToZendesk(fDeal)));
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({
        errors: [{ resource: "deals", code: "not_found", message: err.message }],
      });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v2/deals?ids=a,b,c  o lista paginada
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const idsParam = req.query.ids;
    const perPage = Math.min(Number(req.query.per_page) || 25, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);

    let deals = [];
    if (idsParam) {
      const ids = String(idsParam).split(",").filter(Boolean);
      for (const id of ids) {
        try {
          const d = await frappe.getDoc("CRM Deal", id);
          if (d) deals.push(d);
        } catch {}
      }
    } else {
      const list = await frappe.getList("CRM Deal", {
        fields: ["name"],
        limit: perPage,
        page,
      });
      for (const d of list) {
        try {
          deals.push(await frappe.getDoc("CRM Deal", d.name));
        } catch {}
      }
    }
    res.json(asZendeskList(deals.map(dealFrappeToZendesk)));
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v2/deals
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const zDeal = req.body?.data || req.body;
    if (!zDeal || typeof zDeal !== "object") {
      return res.status(400).json({
        errors: [{ resource: "deals", code: "invalid_body" }],
      });
    }

    const fDoc = dealZendeskToFrappe(zDeal);

    // Child tables: extract Comisiones from ComisionBAR1-6 + Colaboradores from Colaborador*
    const cf = zDeal.custom_fields || {};
    const comisiones = [];
    for (let i = 1; i <= 6; i++) {
      const v = cf[`ComisionBAR${i}`];
      if (v) {
        comisiones.push({
          codigo: String(v).trim(), // user must ensure value matches catalog
          // monto/fecha_pago/colaborador not provided by ZAP — leer aparte si se necesita
        });
      }
    }
    if (comisiones.length) fDoc.comisiones = comisiones;

    const colaboradores = [];
    const colMappings = [
      ["Colaborador 1 (BAR)", "Bariátrica", 1],
      ["Colaborador 3 (BAR)", "Bariátrica", 3],
      ["Colaborador 1 (PLASTICA)", "Plástica", 1],
      ["Colaborador 2 (PLASTICA)", "Plástica", 2],
      ["Colaborador 1 (GENERAL)", "General", 1],
      ["Colaborador 2 (GENERAL)", "General", 2],
      ["Colaborador 1. (BALON)", "Balón", 1],
      ["Colaborador 2 (BALON)", "Balón", 2],
    ];
    for (const [zKey, _pipeline, posicion] of colMappings) {
      const name = cf[zKey];
      if (name) {
        // Try to map first-name-only → catálogo entry
        const firstName = String(name).trim().split(/\s+/)[0];
        colaboradores.push({ posicion, colaborador: firstName });
      }
    }
    if (colaboradores.length) fDoc.colaboradores = colaboradores;

    const created = await frappe.insert("CRM Deal", fDoc);
    res.status(201).json(asZendeskItem(dealFrappeToZendesk(created)));
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /v2/deals/:id
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
  try {
    const zDeal = req.body?.data || req.body;
    const fDoc = dealZendeskToFrappe(zDeal);
    // PUT no maneja child tables incremental — el ZAP update-comisiones solo
    // toca campos top-level. Si necesitamos actualizar comisiones/colaboradores
    // lo agregamos en v0.3.
    const updated = await frappe.update("CRM Deal", req.params.id, fDoc);
    res.json(asZendeskItem(dealFrappeToZendesk(updated)));
  } catch (err) {
    next(err);
  }
});

export default router;
