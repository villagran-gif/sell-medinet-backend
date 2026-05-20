-- twilio-voice/migrations/001-schema.sql
-- Schema del bridge de telefonía Twilio Voice -> Chatwoot.

CREATE SCHEMA IF NOT EXISTS twilio_voice;

-- Log append-only de todos los webhooks recibidos de Twilio.
-- Durabilidad + replay + auditoría (mismo criterio que chatwoot.raw_events).
CREATE TABLE IF NOT EXISTS twilio_voice.raw_events (
  id            BIGSERIAL PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type    TEXT,
  call_sid      TEXT,
  payload       JSONB NOT NULL,
  sig_verified  BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_tv_raw_events_call_sid
  ON twilio_voice.raw_events (call_sid);

CREATE INDEX IF NOT EXISTS idx_tv_raw_events_received_at
  ON twilio_voice.raw_events (received_at DESC);

-- Estado consolidado por llamada.
CREATE TABLE IF NOT EXISTS twilio_voice.calls (
  call_sid                  TEXT PRIMARY KEY,
  from_number               TEXT,
  to_number                 TEXT,
  agent_dialed              TEXT,
  status                    TEXT,   -- incoming | answered | missed | voicemail
  dial_status               TEXT,   -- completed | no-answer | busy | failed | canceled
  duration_seconds          INTEGER,
  recording_url             TEXT,
  recording_seconds         INTEGER,
  chatwoot_source_id        TEXT,
  chatwoot_conversation_id  BIGINT,
  started_at                TIMESTAMPTZ,
  ended_at                  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tv_calls_from
  ON twilio_voice.calls (from_number);

CREATE INDEX IF NOT EXISTS idx_tv_calls_started_at
  ON twilio_voice.calls (started_at DESC);
