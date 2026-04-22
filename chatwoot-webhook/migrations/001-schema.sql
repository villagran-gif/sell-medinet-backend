-- chatwoot-webhook/migrations/001-schema.sql
-- Schema y log append-only para eventos de Chatwoot.

CREATE SCHEMA IF NOT EXISTS chatwoot;

CREATE TABLE IF NOT EXISTS chatwoot.raw_events (
  id             BIGSERIAL PRIMARY KEY,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type     TEXT,
  account_id     BIGINT,
  payload        JSONB NOT NULL,
  sig_verified   BOOLEAN NOT NULL DEFAULT false,
  processed_at   TIMESTAMPTZ,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_raw_events_event_type
  ON chatwoot.raw_events (event_type);

CREATE INDEX IF NOT EXISTS idx_raw_events_received_at
  ON chatwoot.raw_events (received_at DESC);

-- Partial index para cursor de handlers pendientes.
CREATE INDEX IF NOT EXISTS idx_raw_events_unprocessed
  ON chatwoot.raw_events (received_at)
  WHERE processed_at IS NULL;
