-- chatwoot-webhook/migrations/003-missed-call-followups.sql
-- Tracking de follow-ups de WhatsApp para llamadas perdidas.
--
-- Una fila por conversación de voz con missed call (UNIQUE). El handler
-- avanza el status (pending → processing → sent | failed | skipped).
-- Si Chatwoot dispara el webhook 2 veces, el ON CONFLICT mantiene
-- idempotencia: no se envía 2 mensajes al cliente.

CREATE TABLE IF NOT EXISTS chatwoot.missed_call_followups (
  id                       BIGSERIAL PRIMARY KEY,
  conversation_id          BIGINT NOT NULL UNIQUE,
  account_id               BIGINT,
  call_sid                 TEXT,
  customer_phone           TEXT,
  customer_name            TEXT,
  contact_id               BIGINT,
  followup_conversation_id BIGINT,
  template_name            TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending',
  error                    TEXT,
  attempts                 INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcf_status
  ON chatwoot.missed_call_followups (status);

CREATE INDEX IF NOT EXISTS idx_mcf_created
  ON chatwoot.missed_call_followups (created_at DESC);
