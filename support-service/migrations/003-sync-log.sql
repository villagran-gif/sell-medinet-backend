-- 003-sync-log.sql
-- Tabla para registrar diffs entre respuestas de Zendesk y del satélite
-- durante la fase "mirror" del cliente en clinyco_ai. Sirve para:
--   1) medir paridad antes de flipear SUPPORT_BACKEND=satellite
--   2) debug postmortem cuando un endpoint del satélite diverge
-- Cada fila = una operación (get/put/post/etc) comparada.

CREATE TABLE IF NOT EXISTS support.sync_log (
  id          BIGSERIAL PRIMARY KEY,
  entity      TEXT NOT NULL,                -- "user" | "ticket" | "audit" | ...
  entity_id   TEXT,                          -- id del recurso (string; Zendesk usa BIGINT)
  op          TEXT NOT NULL,                -- "get" | "put" | "post" | "getByUrl" | ...
  source      TEXT,                          -- quién lo reportó: "mirror", "client-id", etc
  diff        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_entity_op_created
  ON support.sync_log (entity, op, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_log_source_created
  ON support.sync_log (source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_log_created_at
  ON support.sync_log (created_at DESC);
