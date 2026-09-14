CREATE SCHEMA IF NOT EXISTS attendance;
CREATE TABLE IF NOT EXISTS attendance.requests (
 id bigserial PRIMARY KEY, appointment_id bigint, fingerprint text NOT NULL, snapshot jsonb NOT NULL,
 phone text NOT NULL, conversation_id bigint NOT NULL, message_id bigint UNIQUE,
 state text NOT NULL DEFAULT 'sending', trial boolean NOT NULL DEFAULT false,
 sent_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 verified_at timestamptz, medinet_receipt jsonb, last_intent text,
 UNIQUE(appointment_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS attendance_request_conversation ON attendance.requests(conversation_id);
CREATE TABLE IF NOT EXISTS attendance.events (
 message_id bigint PRIMARY KEY, conversation_id bigint NOT NULL, request_id bigint REFERENCES attendance.requests(id),
 intent text, state text NOT NULL DEFAULT 'processing', ack_id bigint, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS attendance.control (
 conversation_id bigint PRIMARY KEY, paused boolean NOT NULL DEFAULT false, reason text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS attendance.jobs (
 id bigserial PRIMARY KEY, appointment_id bigint NOT NULL, professional_id bigint NOT NULL,
 fingerprint text NOT NULL, send_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'pending',
 error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(appointment_id,fingerprint)
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_trial_key ON attendance.requests(fingerprint) WHERE trial=true;
