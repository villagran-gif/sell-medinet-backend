// Queries de tickets que se comparten entre routes/tickets.js y routes/search.js.
// Encapsular la lógica de creación de ticket+audit+comment en una sola tx.

import { getPool } from "../db.js";

export const PATCHABLE_TICKET_COLUMNS = new Set([
  "external_id",
  "requester_id",
  "assignee_id",
  "subject",
  "description",
  "status",
  "priority",
  "channel",
  "tags",
  "custom_fields",
]);

// Columnas JSONB: pg trata arrays JS como arrays Postgres, no como JSON.
// Para evitar "invalid input syntax for type json" cuando llegan arrays
// (p.ej. Zendesk custom_fields = [{id, value}, ...]), serializamos nosotros.
const JSONB_TICKET_COLUMNS = new Set(["custom_fields"]);

function toJsonbParam(value) {
  return JSON.stringify(value ?? null);
}

async function insertAuditWithComment(client, ticket, authorId, comment) {
  const auditRes = await client.query(
    `INSERT INTO support.ticket_audits
       (ticket_id, author_id, via, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      ticket.id,
      authorId ?? null,
      toJsonbParam({ channel: ticket.channel ?? "api" }),
      toJsonbParam({}),
    ]
  );
  const audit = auditRes.rows[0];

  const eventRes = await client.query(
    `INSERT INTO support.ticket_events
       (audit_id, type, body, plain_body, is_public)
     VALUES ($1, 'Comment', $2, $3, $4)
     RETURNING *`,
    [audit.id, comment.body, comment.body, comment.public ?? true]
  );
  return { audit, event: eventRes.rows[0] };
}

export async function createTicket(input) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const columns = [];
    const placeholders = [];
    const values = [];
    let i = 1;
    for (const col of PATCHABLE_TICKET_COLUMNS) {
      if (input[col] === undefined) continue;
      columns.push(col);
      placeholders.push(`$${i++}`);
      values.push(JSONB_TICKET_COLUMNS.has(col) ? toJsonbParam(input[col]) : input[col]);
    }
    if (columns.length === 0) {
      throw Object.assign(new Error("ticket payload is empty"), { status: 400 });
    }

    const ticketRes = await client.query(
      `INSERT INTO support.tickets (${columns.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING *`,
      values
    );
    const ticket = ticketRes.rows[0];

    let audit = null;
    let event = null;
    if (input.description) {
      const result = await insertAuditWithComment(
        client,
        ticket,
        input.requester_id,
        { body: input.description, public: true }
      );
      audit = result.audit;
      event = result.event;
    }

    await client.query("COMMIT");
    return { ticket, audit, event };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateTicket(id, patch, comment, authorId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let ticket;
    if (patch && Object.keys(patch).length > 0) {
      const sets = [];
      const values = [];
      let i = 1;
      for (const [key, value] of Object.entries(patch)) {
        if (!PATCHABLE_TICKET_COLUMNS.has(key)) continue;
        sets.push(`${key} = $${i++}`);
        values.push(JSONB_TICKET_COLUMNS.has(key) ? toJsonbParam(value) : value);
      }
      if (sets.length > 0) {
        values.push(id);
        const sql = `UPDATE support.tickets SET ${sets.join(", ")}
                     WHERE id = $${i} RETURNING *`;
        const { rows } = await client.query(sql, values);
        if (rows.length === 0) {
          const e = new Error("ticket not found");
          e.status = 404;
          throw e;
        }
        ticket = rows[0];
      }
    }

    if (!ticket) {
      const { rows } = await client.query(
        "SELECT * FROM support.tickets WHERE id = $1",
        [id]
      );
      if (rows.length === 0) {
        const e = new Error("ticket not found");
        e.status = 404;
        throw e;
      }
      ticket = rows[0];
    }

    let audit = null;
    let event = null;
    if (comment?.body) {
      const result = await insertAuditWithComment(
        client,
        ticket,
        authorId,
        comment
      );
      audit = result.audit;
      event = result.event;
      // Touch updated_at on ticket so changes reflect.
      await client.query(
        "UPDATE support.tickets SET updated_at = now() WHERE id = $1",
        [id]
      );
      const refreshed = await client.query(
        "SELECT * FROM support.tickets WHERE id = $1",
        [id]
      );
      ticket = refreshed.rows[0];
    }

    await client.query("COMMIT");
    return { ticket, audit, event };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getTicketAudits(ticketId) {
  const pool = getPool();
  const { rows: audits } = await pool.query(
    `SELECT * FROM support.ticket_audits
     WHERE ticket_id = $1
     ORDER BY id`,
    [ticketId]
  );
  if (audits.length === 0) return [];

  const { rows: events } = await pool.query(
    `SELECT * FROM support.ticket_events
     WHERE audit_id = ANY($1::bigint[])
     ORDER BY id`,
    [audits.map((a) => a.id)]
  );

  const byAudit = new Map();
  for (const a of audits) byAudit.set(String(a.id), []);
  for (const e of events) byAudit.get(String(e.audit_id))?.push(e);

  return audits.map((a) => ({ audit: a, events: byAudit.get(String(a.id)) ?? [] }));
}
