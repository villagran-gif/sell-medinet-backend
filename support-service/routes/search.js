import { Router } from "express";
import { asyncHandler } from "../lib/errors.js";
import { parseZendeskQuery } from "../lib/query.js";
import { searchUsers, searchTickets } from "../lib/search-db.js";
import { mapUserToZendesk, mapTicketToZendesk } from "../lib/zendesk.js";

const router = Router();

// GET /api/v2/search?query=type:user|type:ticket
// Si `type:X` está presente en el query, se filtra a ese recurso. Sin type,
// mezcla users + tickets (results lleva result_type por fila).
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = parseZendeskQuery(req.query.query);
    const types = (parsed.filters.type || []).map((t) =>
      String(t).toLowerCase()
    );
    const { type: _drop, ...rest } = parsed.filters;
    const sub = { filters: rest, freeTerms: parsed.freeTerms };

    const results = [];
    if (types.length === 0 || types.includes("user")) {
      const rows = await searchUsers(sub);
      for (const r of rows) {
        results.push({ ...mapUserToZendesk(r), result_type: "user" });
      }
    }
    if (types.length === 0 || types.includes("ticket")) {
      const rows = await searchTickets(sub);
      for (const r of rows) {
        results.push({ ...mapTicketToZendesk(r), result_type: "ticket" });
      }
    }

    res.json({
      results,
      count: results.length,
      next_page: null,
      previous_page: null,
    });
  })
);

export default router;
