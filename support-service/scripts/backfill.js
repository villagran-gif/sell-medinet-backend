// Backfill desde Zendesk Support → tablas support.*.
// Scope default (c): tickets con status open/pending/hold/new + sus
// requesters + assignees + audits + events.
//
// Uso:
//   node support-service/scripts/backfill.js [--dry-run] [--limit N] [--verbose]
//
// Requiere:
//   - DATABASE_URL (o SUPPORT_DATABASE_URL)
//   - ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN (read-only)
//
// Idempotente: usa UPSERT por id (Zendesk ID = PK en el satélite).
// Se puede correr N veces. Al final, resetea los sequences para evitar
// colisiones con IDs futuros generados localmente.

import { getPool, closePool } from "../db.js";
import { runMigrations } from "../migrations/runner.js";
import { assertCredentials, zdFetch, zdPaginate } from "./zendesk-client.js";

const ARGS = parseArgs(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const VERBOSE = ARGS.has("--verbose");
const LIMIT = getFlag(ARGS, "--limit");

function parseArgs(argv) {
  return new Set(argv);
}
function getFlag(args, name) {
  for (const a of args) {
    if (a.startsWith(`${name}=`)) return Number(a.split("=")[1]);
  }
  return null;
}

function log(...args) {
  console.log("[backfill]", ...args);
}
function vlog(...args) {
  if (VERBOSE) console.log("[backfill:v]", ...args);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchOpenTickets() {
  const query = encodeURIComponent("type:ticket status<solved");
  log("fetching open tickets from Zendesk...");
  const tickets = [];
  for await (const t of zdPaginate(
    `/api/v2/search.json?query=${query}&sort_by=updated_at&sort_order=desc&per_page=100`,
    "results"
  )) {
    tickets.push(t);
    if (LIMIT && tickets.length >= LIMIT) break;
  }
  log(`found ${tickets.length} open tickets`);
  return tickets;
}

async function fetchUsersByIds(ids) {
  if (ids.length === 0) return [];
  const users = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    vlog(`fetching users ${i + 1}..${i + batch.length} of ${ids.length}`);
    const data = await zdFetch(
      `/api/v2/users/show_many.json?ids=${batch.join(",")}`
    );
    users.push(...(data.users || []));
  }
  return users;
}

async function fetchIdentitiesForUser(userId) {
  const out = [];
  for await (const id of zdPaginate(
    `/api/v2/users/${userId}/identities.json?per_page=100`,
    "identities"
  )) {
    out.push(id);
  }
  return out;
}

async function fetchAuditsForTicket(ticketId) {
  const out = [];
  for await (const a of zdPaginate(
    `/api/v2/tickets/${ticketId}/audits.json?per_page=100`,
    "audits"
  )) {
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

async function upsertUser(client, u) {
  if (DRY_RUN) {
    vlog(`dry-run user ${u.id}`);
    return u.id;
  }
  await client.query(
    `INSERT INTO support.users
       (id, legacy_zendesk_id, external_id, name, email, phone, notes,
        role, active, user_fields, tags)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       external_id = EXCLUDED.external_id,
       name        = EXCLUDED.name,
       email       = EXCLUDED.email,
       phone       = EXCLUDED.phone,
       notes       = EXCLUDED.notes,
       role        = EXCLUDED.role,
       active      = EXCLUDED.active,
       user_fields = EXCLUDED.user_fields,
       tags        = EXCLUDED.tags`,
    [
      u.id,
      u.external_id ?? null,
      u.name ?? null,
      u.email ?? null,
      u.phone ?? null,
      u.notes ?? null,
      u.role ?? "end-user",
      u.active ?? true,
      u.user_fields ?? {},
      u.tags ?? [],
    ]
  );
  return u.id;
}

async function upsertIdentity(client, userId, ident) {
  if (DRY_RUN) return;
  await client.query(
    `INSERT INTO support.user_identities
       (id, user_id, type, value, verified, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       type       = EXCLUDED.type,
       value      = EXCLUDED.value,
       verified   = EXCLUDED.verified,
       is_primary = EXCLUDED.is_primary`,
    [
      ident.id,
      userId,
      ident.type ?? "unknown",
      ident.value ?? "",
      Boolean(ident.verified),
      Boolean(ident.primary),
    ]
  );
}

async function upsertTicket(client, t) {
  if (DRY_RUN) {
    vlog(`dry-run ticket ${t.id}`);
    return;
  }
  await client.query(
    `INSERT INTO support.tickets
       (id, legacy_zendesk_id, external_id, requester_id, assignee_id,
        subject, description, status, priority, channel, tags, custom_fields,
        created_at, updated_at)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             COALESCE($12, now()), COALESCE($13, now()))
     ON CONFLICT (id) DO UPDATE SET
       external_id   = EXCLUDED.external_id,
       requester_id  = EXCLUDED.requester_id,
       assignee_id   = EXCLUDED.assignee_id,
       subject       = EXCLUDED.subject,
       description   = EXCLUDED.description,
       status        = EXCLUDED.status,
       priority      = EXCLUDED.priority,
       channel       = EXCLUDED.channel,
       tags          = EXCLUDED.tags,
       custom_fields = EXCLUDED.custom_fields,
       updated_at    = EXCLUDED.updated_at`,
    [
      t.id,
      t.external_id ?? null,
      t.requester_id ?? null,
      t.assignee_id ?? null,
      t.subject ?? null,
      t.description ?? null,
      t.status ?? "open",
      t.priority ?? null,
      t.via?.channel ?? "api",
      t.tags ?? [],
      t.custom_fields ?? {},
      t.created_at ?? null,
      t.updated_at ?? null,
    ]
  );
}

async function upsertAuditAndEvents(client, ticketId, audit) {
  if (DRY_RUN) return;
  await client.query(
    `INSERT INTO support.ticket_audits
       (id, legacy_zendesk_id, ticket_id, author_id, via, metadata, created_at)
     VALUES ($1, $1, $2, $3, $4, $5, COALESCE($6, now()))
     ON CONFLICT (id) DO UPDATE SET
       ticket_id  = EXCLUDED.ticket_id,
       author_id  = EXCLUDED.author_id,
       via        = EXCLUDED.via,
       metadata   = EXCLUDED.metadata,
       created_at = EXCLUDED.created_at`,
    [
      audit.id,
      ticketId,
      audit.author_id ?? null,
      audit.via ?? {},
      audit.metadata ?? {},
      audit.created_at ?? null,
    ]
  );

  for (const ev of audit.events ?? []) {
    // Solo persistimos events conocidos por el schema. Comments son lo
    // relevante para clinyco_ai; el resto se captura como Change con payload.
    const type = ev.type || "Event";
    const { id, body, html_body, plain_body, public: isPublic, ...rest } = ev;
    await client.query(
      `INSERT INTO support.ticket_events
         (id, audit_id, type, body, html_body, plain_body, is_public, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         audit_id   = EXCLUDED.audit_id,
         type       = EXCLUDED.type,
         body       = EXCLUDED.body,
         html_body  = EXCLUDED.html_body,
         plain_body = EXCLUDED.plain_body,
         is_public  = EXCLUDED.is_public,
         payload    = EXCLUDED.payload`,
      [
        id,
        audit.id,
        type,
        body ?? null,
        html_body ?? null,
        plain_body ?? null,
        isPublic ?? true,
        rest,
      ]
    );
  }
}

// ---------------------------------------------------------------------------
// Sequences — reseteo para evitar colisiones con Zendesk IDs existentes
// ---------------------------------------------------------------------------

async function resetSequences(client) {
  if (DRY_RUN) return;
  const tables = [
    ["users", "users_id_seq"],
    ["user_identities", "user_identities_id_seq"],
    ["tickets", "tickets_id_seq"],
    ["ticket_audits", "ticket_audits_id_seq"],
    ["ticket_events", "ticket_events_id_seq"],
  ];
  for (const [table, seq] of tables) {
    await client.query(
      `SELECT setval('support.${seq}',
         GREATEST((SELECT COALESCE(MAX(id), 1) FROM support.${table}), 1))`
    );
  }
  log("sequences reset to max(id)");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  assertCredentials();

  log(DRY_RUN ? "DRY RUN mode (no writes)" : "LIVE mode (writes to DB)");
  if (LIMIT) log(`limiting to first ${LIMIT} tickets`);

  const pool = getPool();
  if (!DRY_RUN) {
    log("ensuring migrations are applied...");
    await runMigrations();
  }

  const tickets = await fetchOpenTickets();
  if (tickets.length === 0) {
    log("nothing to backfill");
    return;
  }

  // Recolectar ids únicos de users referenciados
  const userIds = new Set();
  for (const t of tickets) {
    if (t.requester_id) userIds.add(t.requester_id);
    if (t.assignee_id) userIds.add(t.assignee_id);
    if (t.submitter_id) userIds.add(t.submitter_id);
  }
  log(`collecting ${userIds.size} unique users`);

  const users = await fetchUsersByIds([...userIds]);
  log(`fetched ${users.length} users from Zendesk`);

  const stats = { users: 0, identities: 0, tickets: 0, audits: 0, events: 0, errors: 0 };

  // 1) Users (tx por user + sus identities)
  for (const u of users) {
    try {
      await withTx(pool, async (client) => {
        await upsertUser(client, u);
        stats.users++;
        const identities = await fetchIdentitiesForUser(u.id);
        for (const ident of identities) {
          await upsertIdentity(client, u.id, ident);
          stats.identities++;
        }
      });
    } catch (err) {
      stats.errors++;
      console.error(`[backfill] user ${u.id} failed:`, err.message);
    }
    if (stats.users % 25 === 0) log(`progress: ${stats.users}/${users.length} users`);
  }

  // 2) Tickets (tx por ticket + sus audits)
  for (const t of tickets) {
    try {
      await withTx(pool, async (client) => {
        await upsertTicket(client, t);
        stats.tickets++;
        const audits = await fetchAuditsForTicket(t.id);
        for (const a of audits) {
          await upsertAuditAndEvents(client, t.id, a);
          stats.audits++;
          stats.events += (a.events ?? []).length;
        }
      });
    } catch (err) {
      stats.errors++;
      console.error(`[backfill] ticket ${t.id} failed:`, err.message);
    }
    if (stats.tickets % 10 === 0) {
      log(`progress: ${stats.tickets}/${tickets.length} tickets`);
    }
  }

  // 3) Reset de sequences al final
  try {
    await withTx(pool, resetSequences);
  } catch (err) {
    console.error("[backfill] sequence reset failed:", err.message);
    stats.errors++;
  }

  log("DONE:", stats);
  if (stats.errors > 0) process.exitCode = 1;
}

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("[backfill] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
