-- chatwoot-webhook/migrations/002-call-transcriptions.sql
-- Tabla para transcripciones de llamadas Twilio (Chatwoot Voice).
--
-- Una fila por (conversation_id, call_sid). El handler avanza el `status`
-- (pending → processing → done | failed). Las pendientes/failed las
-- reintenta /transcriptions/retry-pending hasta `attempts < 5`.

CREATE TABLE IF NOT EXISTS chatwoot.call_transcriptions (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  account_id      BIGINT,
  call_sid        TEXT NOT NULL,
  recording_sid   TEXT,
  recording_url   TEXT,
  duration_sec    INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending',
  transcript      TEXT,
  language        TEXT,
  whisper_model   TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_conv_call UNIQUE (conversation_id, call_sid)
);

CREATE INDEX IF NOT EXISTS idx_ct_status
  ON chatwoot.call_transcriptions (status);

CREATE INDEX IF NOT EXISTS idx_ct_pending_retry
  ON chatwoot.call_transcriptions (updated_at)
  WHERE status IN ('pending', 'failed');
