import { Router } from "express";
import { getPool } from "../db.js";
import { asyncHandler, HttpError } from "../lib/errors.js";
import {
  mapTicketToZendesk,
  mapAuditToZendesk,
  mapEventToZendesk,
} from "../lib/zendesk.js";
import {
  createTicket,
  updateTicket,
  getTicketAudits,
} from "../lib/tickets-db.js";

const router = Router();

function parseTicketId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "invalid ticket id");
  }
  return id;
}

// POST /api/v2/tickets      body: { ticket: {...} }
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = req.body?.ticket;
    if (!input || typeof input !== "object") {
      throw new HttpError(400, "missing ticket object in body");
    }
    try {
      const { ticket, audit, event } = await createTicket(input);
      const response = { ticket: mapTicketToZendesk(ticket) };
      if (audit) {
        response.audit = mapAuditToZendesk(audit, event ? [event] : []);
      }
      res.status(201).json(response);
    } catch (err) {
      if (err.status) throw new HttpError(err.status, err.message);
      throw err;
    }
  })
);

// GET /api/v2/tickets/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseTicketId(req.params.id);
    const { rows } = await getPool().query(
      "SELECT * FROM support.tickets WHERE id = $1",
      [id]
    );
    if (rows.length === 0) throw new HttpError(404, "ticket not found");
    res.json({ ticket: mapTicketToZendesk(rows[0]) });
  })
);

// PUT /api/v2/tickets/:id    body: { ticket: { ...patch, comment?: { body, public } } }
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseTicketId(req.params.id);
    const input = req.body?.ticket;
    if (!input || typeof input !== "object") {
      throw new HttpError(400, "missing ticket object in body");
    }
    const { comment, ...patch } = input;
    const authorId = patch.author_id;
    delete patch.author_id;

    try {
      const { ticket, audit, event } = await updateTicket(
        id,
        patch,
        comment,
        authorId
      );
      const response = { ticket: mapTicketToZendesk(ticket) };
      if (audit) {
        response.audit = mapAuditToZendesk(audit, event ? [event] : []);
      }
      res.json(response);
    } catch (err) {
      if (err.status) throw new HttpError(err.status, err.message);
      throw err;
    }
  })
);

// GET /api/v2/tickets/:id/audits
router.get(
  "/:id/audits",
  asyncHandler(async (req, res) => {
    const id = parseTicketId(req.params.id);
    const { rows } = await getPool().query(
      "SELECT 1 FROM support.tickets WHERE id = $1",
      [id]
    );
    if (rows.length === 0) throw new HttpError(404, "ticket not found");

    const bundle = await getTicketAudits(id);
    res.json({
      audits: bundle.map(({ audit, events }) => mapAuditToZendesk(audit, events)),
      count: bundle.length,
      next_page: null,
      previous_page: null,
    });
  })
);

// GET /api/v2/tickets/:id/comments
// Vista convenience: flatten de todos los events de tipo Comment.
router.get(
  "/:id/comments",
  asyncHandler(async (req, res) => {
    const id = parseTicketId(req.params.id);
    const { rows } = await getPool().query(
      "SELECT 1 FROM support.tickets WHERE id = $1",
      [id]
    );
    if (rows.length === 0) throw new HttpError(404, "ticket not found");

    const { rows: events } = await getPool().query(
      `SELECT e.*, a.author_id, a.created_at AS audit_created_at
       FROM support.ticket_events e
       JOIN support.ticket_audits a ON a.id = e.audit_id
       WHERE a.ticket_id = $1 AND e.type = 'Comment'
       ORDER BY e.id`,
      [id]
    );

    res.json({
      comments: events.map((e) => ({
        ...mapEventToZendesk(e),
        author_id: e.author_id != null ? Number(e.author_id) : null,
        created_at:
          e.audit_created_at?.toISOString?.() ?? e.audit_created_at,
      })),
      count: events.length,
      next_page: null,
      previous_page: null,
    });
  })
);

export default router;
