-- confirmations/migrations/001-schema.sql
-- Schema MelanIA: sistema de confirmaciones de citas vía Chatwoot Cloud.
--
-- Reemplaza CEROAI. Ciclo:
--   intake (push desde clinyco_AI/VPS) → first_msg_sent → {confirmed|cancelled|
--   reschedule_requested|no_response} → [reminder_sent T-76h si aplica] → ...
--
-- Ver confirmations/README.md para el flujo completo.

CREATE SCHEMA IF NOT EXISTS confirmations;

-- =============================================================
-- appointments: una fila por cita Medinet que entra al sistema.
-- =============================================================
CREATE TABLE IF NOT EXISTS confirmations.appointments (
  id                       BIGSERIAL PRIMARY KEY,
  external_id              BIGINT NOT NULL UNIQUE,    -- Medinet appointment id
  branch_id                INTEGER NOT NULL,
  branch_name              TEXT,
  specialty                TEXT,
  professional             TEXT,
  appointment_at           TIMESTAMPTZ NOT NULL,
  duration_min             INTEGER,
  patient_run              TEXT,
  patient_name             TEXT,
  patient_phone            TEXT NOT NULL,             -- E.164 si viene normalizado
  patient_email            TEXT,
  state                    TEXT NOT NULL DEFAULT 'scheduled',
    -- scheduled | first_msg_sent | confirmed | cancelled
    -- | reschedule_requested | reminder_sent | no_response
  medinet_state            TEXT,                      -- estado.nombre desde Medinet (Confirmado, Pendiente, etc.)
  chatwoot_contact_id      BIGINT,
  chatwoot_conversation_id BIGINT,
  first_msg_sent_at        TIMESTAMPTZ,
  reminder_sent_at         TIMESTAMPTZ,
  last_inbound_at          TIMESTAMPTZ,
  raw                      JSONB NOT NULL,            -- payload normalizado original
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointments_state
  ON confirmations.appointments (state);

CREATE INDEX IF NOT EXISTS idx_appointments_appointment_at
  ON confirmations.appointments (appointment_at);

CREATE INDEX IF NOT EXISTS idx_appointments_patient_phone
  ON confirmations.appointments (patient_phone);

-- Partial index para el scheduler: candidatos a recordatorio T-76h.
CREATE INDEX IF NOT EXISTS idx_appointments_pending_reminder
  ON confirmations.appointments (appointment_at)
  WHERE reminder_sent_at IS NULL
    AND state IN ('first_msg_sent', 'confirmed');

-- =============================================================
-- outbound_messages: log de cada template enviado. Idempotencia
-- (un template_name por appointment_id se manda una sola vez).
-- =============================================================
CREATE TABLE IF NOT EXISTS confirmations.outbound_messages (
  id                  BIGSERIAL PRIMARY KEY,
  appointment_id      BIGINT NOT NULL REFERENCES confirmations.appointments(id) ON DELETE CASCADE,
  template_name       TEXT NOT NULL,
  template_params     JSONB,
  chatwoot_message_id BIGINT,
  dry_run             BOOLEAN NOT NULL DEFAULT false,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  error               TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_appointment_template
  ON confirmations.outbound_messages (appointment_id, template_name)
  WHERE error IS NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_sent_at
  ON confirmations.outbound_messages (sent_at DESC);

-- =============================================================
-- inbound_classifications: log de decisiones del clasificador Haiku 4.5
-- sobre los mensajes recibidos vía chatwoot.raw_events.
-- =============================================================
CREATE TABLE IF NOT EXISTS confirmations.inbound_classifications (
  id              BIGSERIAL PRIMARY KEY,
  raw_event_id    BIGINT,                              -- chatwoot.raw_events.id (sin FK: otro schema)
  appointment_id  BIGINT REFERENCES confirmations.appointments(id) ON DELETE SET NULL,
  intent          TEXT,                                -- confirm | cancel | reschedule | other | ambiguous
  confidence      NUMERIC(4, 3),
  raw_message     TEXT,
  model           TEXT,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_appointment
  ON confirmations.inbound_classifications (appointment_id);

CREATE INDEX IF NOT EXISTS idx_inbound_raw_event
  ON confirmations.inbound_classifications (raw_event_id);
