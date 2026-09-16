CREATE SCHEMA IF NOT EXISTS attendance_direct;
CREATE TABLE IF NOT EXISTS attendance_direct.requests (
 id bigserial PRIMARY KEY, request_key text UNIQUE NOT NULL, snapshot jsonb NOT NULL,
 phone text NOT NULL, trial boolean NOT NULL, state text NOT NULL DEFAULT 'sending',
 message_id text UNIQUE, delivery text NOT NULL DEFAULT 'unknown',
 reply text, intent text, medinet_status text, verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 error text, actor text NOT NULL,
 chatwoot_conversation_id bigint, chatwoot_context_noted_at timestamptz
);
CREATE TABLE IF NOT EXISTS attendance_direct.events (
 id text PRIMARY KEY, phone text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS attendance_direct.outbox (
 id text PRIMARY KEY, phone text NOT NULL, body jsonb NOT NULL,
 state text NOT NULL DEFAULT 'sending', message_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS attendance_direct.control (
 phone text PRIMARY KEY, paused boolean NOT NULL DEFAULT false, reason text, updated_at timestamptz NOT NULL DEFAULT now()
);

