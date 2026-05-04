/**
 * /v2/notes — POST a note attached to a Deal/Contact/Lead.
 *
 * Zendesk Sell Note shape:
 *   { data: { resource_type: "deal"|"contact"|"lead", resource_id: 123, content: "..." } }
 *
 * Frappe equivalente: FCRM Note doctype tiene:
 *   - title, content
 *   - reference_docname / reference_doctype (vinculado a CRM Deal/Lead/etc)
 */

import { Router } from "express";
import { frappe } from "../lib/frappe-client.js";

const router = Router();

const RESOURCE_TO_DOCTYPE = {
  deal: "CRM Deal",
  contact: "Contact",
  lead: "CRM Lead",
};

router.post("/", async (req, res, next) => {
  try {
    const zNote = req.body?.data || req.body;
    if (!zNote?.resource_type || !zNote?.resource_id || !zNote?.content) {
      return res.status(400).json({
        errors: [
          {
            resource: "notes",
            code: "invalid_body",
            message: "expected { resource_type, resource_id, content }",
          },
        ],
      });
    }

    const refDoctype = RESOURCE_TO_DOCTYPE[zNote.resource_type.toLowerCase()];
    if (!refDoctype) {
      return res.status(400).json({
        errors: [
          {
            resource: "notes",
            code: "invalid_resource_type",
            message: `resource_type debe ser deal/contact/lead, recibido: ${zNote.resource_type}`,
          },
        ],
      });
    }

    const fNote = await frappe.insert("FCRM Note", {
      title: zNote.content.slice(0, 100),
      content: zNote.content,
      reference_doctype: refDoctype,
      reference_docname: String(zNote.resource_id),
    });

    res.status(201).json({
      data: {
        id: fNote.name,
        resource_type: zNote.resource_type,
        resource_id: zNote.resource_id,
        content: zNote.content,
        created_at: fNote.creation,
        updated_at: fNote.modified,
      },
      meta: { type: "note" },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
