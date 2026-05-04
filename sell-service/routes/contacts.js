/**
 * /v2/contacts — CRUD compatible con Zendesk Sell.
 *
 * Endpoints:
 *   GET    /v2/contacts/:id
 *   GET    /v2/contacts?ids=1,2,3   (alias multi-get)
 *   POST   /v2/contacts             (body: { data: { first_name, custom_fields, ... } })
 *   PUT    /v2/contacts/:id
 */

import { Router } from "express";
import { frappe } from "../lib/frappe-client.js";
import {
  contactZendeskToFrappe,
  contactFrappeToZendesk,
} from "../lib/translator.js";

const router = Router();

// Wrap to Zendesk single-item shape: { data: {...}, meta: {...} }
function asZendeskItem(d) {
  return { data: d, meta: { type: "contact" } };
}
function asZendeskList(items) {
  return {
    items: items.map((d) => ({ data: d, meta: { type: "contact" } })),
    meta: { type: "collection", count: items.length },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v2/contacts/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const fContact = await frappe.getDoc("Contact", req.params.id);
    if (!fContact) {
      return res.status(404).json({
        errors: [{ resource: "contacts", code: "not_found", message: "Contact no encontrado" }],
      });
    }
    res.json(asZendeskItem(contactFrappeToZendesk(fContact)));
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({
        errors: [{ resource: "contacts", code: "not_found", message: err.message }],
      });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v2/contacts?ids=a,b,c  (multi-get) o lista simple
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const idsParam = req.query.ids;
    const perPage = Math.min(Number(req.query.per_page) || 25, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);

    let contacts;
    if (idsParam) {
      const ids = String(idsParam).split(",").filter(Boolean);
      contacts = [];
      for (const id of ids) {
        try {
          const c = await frappe.getDoc("Contact", id);
          if (c) contacts.push(c);
        } catch {
          // skip not-found ids; Zendesk también no aborta el batch
        }
      }
    } else {
      contacts = await frappe.getList("Contact", {
        fields: ["name"],
        limit: perPage,
        page,
      });
      // get full doc for each (Zendesk devuelve full)
      const fulls = [];
      for (const c of contacts) {
        try {
          fulls.push(await frappe.getDoc("Contact", c.name));
        } catch {}
      }
      contacts = fulls;
    }
    res.json(asZendeskList(contacts.map(contactFrappeToZendesk)));
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v2/contacts  (Zendesk wrapper: { data: {...} })
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const zContact = req.body?.data || req.body;
    if (!zContact || typeof zContact !== "object") {
      return res.status(400).json({
        errors: [{ resource: "contacts", code: "invalid_body", message: "expected { data: {...} }" }],
      });
    }

    const fDoc = contactZendeskToFrappe(zContact);
    if (!fDoc.first_name && !fDoc.last_name) {
      return res.status(400).json({
        errors: [{ resource: "contacts", code: "missing_required", message: "first_name or last_name requerido" }],
      });
    }

    const created = await frappe.insert("Contact", fDoc);
    res.status(201).json(asZendeskItem(contactFrappeToZendesk(created)));
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /v2/contacts/:id
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
  try {
    const zContact = req.body?.data || req.body;
    const fDoc = contactZendeskToFrappe(zContact);
    const updated = await frappe.update("Contact", req.params.id, fDoc);
    res.json(asZendeskItem(contactFrappeToZendesk(updated)));
  } catch (err) {
    next(err);
  }
});

export default router;
