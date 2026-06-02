// support-normalizer/db.js
//
// Escrituras idempotentes a `support.*` desde eventos de Chatwoot. Reusa el
// pool de support-service (dueño del schema). Solo DML — el DDL (columnas
// chatwoot_* + unique indexes) vive en
// support-service/migrations/004-chatwoot-source.sql.
//
// Idempotencia: el upsert de user/ticket es por id de Chatwoot (unique index
// parcial). El comentario se inserta una vez por evento porque el dispatcher
// reclama cada raw_event una sola vez (processed_at). Dedupe por message id
// queda como mejora futura (ver README).

import { getPool } from "../support-service/db.js";
import { mapStatus } from "./map.js";

async function upsertUser(client, contact) {
  if (contact.chatwootId != null) {
    const { rows } = await client.query(
      `INSERT INTO support.users (chatwoot_contact_id, name, email, phone)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (chatwoot_contact_id) WHERE chatwoot_contact_id IS NOT NULL
         DO UPDATE SET
           name  = COALESCE(EXCLUDED.name,  support.users.name),
           email = COALESCE(EXCLUDED.email, support.users.email),
           phone = COALESCE(EXCLUDED.phone, support.users.phone)
       RETURNING id`,
      [contact.chatwootId, contact.name, contact.email, contact.phone]
    );
    return rows[0].id;
  }

  // Sin id de Chatwoot: intentar reusar por teléfono antes de crear.
  if (contact.phone) {
    const found = await client.query(
      "SELECT id FROM support.users WHERE phone = $1 ORDER BY id LIMIT 1",
      [contact.phone]
    );
    if (found.rows.length) return found.rows[0].id;
    const { rows } = await client.query(
      `INSERT INTO support.users (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
      [contact.name, contact.email, contact.phone]
    );
    return rows[0].id;
  }

  // Contacto anónimo (sin id ni teléfono).
  const { rows } = await client.query(
    `INSERT INTO support.users (name) VALUES ($1) RETURNING id`,
    [contact.name || "Chatwoot contact"]
  );
  return rows[0].id;
}

async function upsertTicket(client, conversation, requesterId) {
  const { rows } = await client.query(
    `INSERT INTO support.tickets
         (chatwoot_conversation_id, requester_id, subject, status, channel)
       VALUES ($1, $2, $3, $4, 'chatwoot')
     ON CONFLICT (chatwoot_conversation_id) WHERE chatwoot_conversation_id IS NOT NULL
       DO UPDATE SET
         status       = EXCLUDED.status,
         requester_id = COALESCE(support.tickets.requester_id, EXCLUDED.requester_id),
         updated_at   = now()
     RETURNING id`,
    [conversation.chatwootId, requesterId, conversation.subject, mapStatus(conversation.status)]
  );
  return rows[0].id;
}

async function appendComment(client, ticketId, authorId, comment) {
  const audit = await client.query(
    `INSERT INTO support.ticket_audits (ticket_id, author_id, via, metadata)
       VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      ticketId,
      authorId ?? null,
      JSON.stringify({ channel: "chatwoot" }),
      JSON.stringify({ source: "chatwoot", incoming: comment.isIncoming }),
    ]
  );
  await client.query(
    `INSERT INTO support.ticket_events (audit_id, type, body, plain_body, is_public)
       VALUES ($1, 'Comment', $2, $3, $4)`,
    [audit.rows[0].id, comment.body, comment.body, comment.isPublic]
  );
}

// Espeja un mensaje (ya mapeado) en support.* en una sola transacción:
// upsert user → upsert ticket → append comment.
export async function mirrorMessage(mapped) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userId = await upsertUser(client, mapped.contact);
    const ticketId = await upsertTicket(client, mapped.conversation, userId);
    await appendComment(client, ticketId, userId, mapped.comment);
    await client.query("COMMIT");
    return { userId, ticketId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
