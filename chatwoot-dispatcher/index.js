// chatwoot-dispatcher/index.js
//
// Único consumidor de `chatwoot.raw_events` (eventos `message_created`).
// Reclama eventos con FOR UPDATE SKIP LOCKED y los rutea a handlers activos
// según inbox_id. Los únicos handlers soportados son MelanIA y AntonIA.

import { getPool } from "../chatwoot-webhook/db.js";
import { parseRoutingConfig, resolveHandlerKeys } from "./routing.js";

const HANDLER_LOADERS = {
  melania: () =>
    import("../confirmations/inbound-processor.js").then((m) => m.handleInboundEvent),
  antonia: () =>
    import("../antonia-bridge/index.js").then((m) => m.handleInboundEvent),
};

const handlerCache = new Map();
async function loadHandler(key) {
  if (handlerCache.has(key)) return handlerCache.get(key);
  const loader = HANDLER_LOADERS[key];
  if (!loader) return null;
  const fn = await loader();
  handlerCache.set(key, fn);
  return fn;
}

const CLAIM_SQL = `
  WITH next AS (
    SELECT id
      FROM chatwoot.raw_events
     WHERE processed_at IS NULL
       AND event_type = 'message_created'
     ORDER BY received_at ASC
     LIMIT $1
       FOR UPDATE SKIP LOCKED
  )
  UPDATE chatwoot.raw_events r
     SET processed_at = now()
    FROM next
   WHERE r.id = next.id
  RETURNING r.id, r.event_type, r.payload
`;

async function recordError(pool, id, message) {
  try {
    await pool.query("UPDATE chatwoot.raw_events SET error = $2 WHERE id = $1", [
      id,
      String(message).slice(0, 500),
    ]);
  } catch (err) {
    console.error("[chatwoot-dispatcher] no se pudo registrar el error:", err.message);
  }
}

export async function dispatchPending({ limit = 50 } = {}) {
  const pool = getPool();
  const config = parseRoutingConfig();
  const { rows } = await pool.query(CLAIM_SQL, [limit]);

  const summary = { scanned: rows.length, dispatched: 0, errors: 0, byHandler: {} };

  for (const ev of rows) {
    const keys = resolveHandlerKeys(ev.payload, config);
    for (const key of keys) {
      let handler;
      try {
        handler = await loadHandler(key);
      } catch (err) {
        summary.errors++;
        console.error(`[chatwoot-dispatcher] no se pudo cargar handler '${key}':`, err.message);
        continue;
      }
      if (!handler) {
        summary.errors++;
        await recordError(pool, ev.id, `handler desconocido: ${key}`);
        console.warn(`[chatwoot-dispatcher] handler desconocido '${key}' (evento ${ev.id})`);
        continue;
      }
      try {
        await handler(ev);
        summary.dispatched++;
        summary.byHandler[key] = (summary.byHandler[key] || 0) + 1;
      } catch (err) {
        summary.errors++;
        await recordError(pool, ev.id, `${key}: ${err.message}`);
        console.error(
          `[chatwoot-dispatcher] handler '${key}' falló en evento ${ev.id}:`,
          err.message
        );
      }
    }
  }
  return summary;
}
