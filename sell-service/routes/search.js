/**
 * Search API v3 (Zendesk Sell Search Service).
 *
 * Body shape Zendesk:
 *   {
 *     "query": {
 *       "filter": {
 *         "and": [
 *           { "filter": { "attribute": { "name": "custom_fields:RUT_normalizado" },
 *                         "parameter": { "eq": "12345678-9" } } }
 *         ]
 *       },
 *       "projection": { "size": 25 },
 *       "page": 1
 *     }
 *   }
 *
 * Esta implementación cubre el caso más usado por box-ai-clinyco:
 * búsqueda de Contact/Deal por custom_fields:RUT_normalizado.
 *
 * Para queries complejas (and/or anidados, múltiples atributos, sort, etc) →
 * v0.3. Por ahora extrae el primer "eq" de la query y busca por ese valor.
 */

import { Router } from "express";
import { frappe } from "../lib/frappe-client.js";
import {
  contactFrappeToZendesk,
  dealFrappeToZendesk,
  CONTACT_TO_FRAPPE,
  DEAL_TO_FRAPPE,
} from "../lib/translator.js";

const router = Router();

/**
 * Recursively extract first attribute filter from Zendesk-shape query.
 * @returns {{attribute: string, value: any} | null}
 */
function extractFirstFilter(filter) {
  if (!filter) return null;
  if (filter.filter) {
    const f = filter.filter;
    if (f.attribute?.name && f.parameter?.eq != null) {
      return { attribute: f.attribute.name, value: f.parameter.eq };
    }
  }
  for (const key of ["and", "or"]) {
    if (Array.isArray(filter[key])) {
      for (const sub of filter[key]) {
        const r = extractFirstFilter(sub);
        if (r) return r;
      }
    }
  }
  return null;
}

/**
 * Map Zendesk attribute name (e.g. "custom_fields:RUT_normalizado") to Frappe fieldname.
 */
function attributeToFrappeField(attr, kind /* contact|deal */) {
  if (attr.startsWith("custom_fields:")) {
    const zKey = attr.slice("custom_fields:".length);
    const map = kind === "deal" ? DEAL_TO_FRAPPE : CONTACT_TO_FRAPPE;
    return map[zKey] || null;
  }
  // Standard fields — pass through (handle few common cases)
  const standard = {
    email: "email_id",
    phone: "phone",
    mobile: "mobile_no",
    name: "name",
    first_name: "first_name",
    last_name: "last_name",
  };
  return standard[attr] || attr;
}

async function searchAndRespond(req, res, next, kind) {
  try {
    const query = req.body?.query;
    if (!query) {
      return res.status(400).json({
        errors: [{ resource: kind + "s", code: "missing_query" }],
      });
    }

    const filter = extractFirstFilter(query.filter);
    const size = Math.min(Number(query.projection?.size) || 25, 100);
    const page = Math.max(Number(query.page) || 1, 1);

    if (!filter) {
      return res.status(400).json({
        errors: [
          {
            resource: kind + "s",
            code: "unsupported_query",
            message: "Solo se soportan filtros simples eq sobre 1 atributo. Ver search.js v0.2.",
          },
        ],
      });
    }

    const doctype = kind === "deal" ? "CRM Deal" : "Contact";
    const fField = attributeToFrappeField(filter.attribute, kind);
    if (!fField) {
      return res.status(400).json({
        errors: [
          {
            resource: kind + "s",
            code: "unsupported_attribute",
            message: `Atributo ${filter.attribute} no mapeable a Frappe fieldname`,
          },
        ],
      });
    }

    // Query Frappe
    const list = await frappe.getList(doctype, {
      filters: [[fField, "=", filter.value]],
      fields: ["name"],
      limit: size,
      page,
    });

    // Get full docs
    const fulls = [];
    for (const item of list) {
      try {
        fulls.push(await frappe.getDoc(doctype, item.name));
      } catch {}
    }

    const items = fulls.map(
      kind === "deal" ? dealFrappeToZendesk : contactFrappeToZendesk
    );

    res.json({
      items: items.map((d) => ({ data: d, meta: { type: kind } })),
      meta: {
        type: "collection",
        count: items.length,
        page,
        per_page: size,
        // Zendesk también incluye total_count cuando include_count=true
        total_count: items.length,
      },
    });
  } catch (err) {
    next(err);
  }
}

router.post("/contacts/search", (req, res, next) =>
  searchAndRespond(req, res, next, "contact")
);
router.post("/deals/search", (req, res, next) =>
  searchAndRespond(req, res, next, "deal")
);

export default router;
