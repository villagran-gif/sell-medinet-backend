-- 001-schema.sql — Tablas espejo de Zendesk Support.
-- Idempotente. El runner lo aplica una sola vez (registra en support.migrations).

CREATE SCHEMA IF NOT EXISTS support;

CREATE TABLE IF NOT EXISTS support.migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- users
-- =========================================================================
CREATE TABLE IF NOT EXISTS support.users (
  id                 BIGSERIAL PRIMARY KEY,
  legacy_zendesk_id  BIGINT UNIQUE,
  external_id        TEXT,
  name               TEXT,
  email              TEXT,
  phone              TEXT,
  notes              TEXT,
  role               TEXT NOT NULL DEFAULT 'end-user',
  active             BOOLEAN NOT NULL DEFAULT true,
  user_fields        JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_users_email_lower
  ON support.users (lower(email));
CREATE INDEX IF NOT EXISTS idx_support_users_phone
  ON support.users (phone);
CREATE INDEX IF NOT EXISTS idx_support_users_external_id
  ON support.users (external_id);

-- =========================================================================
-- user_identities (email/phone/external secundarios)
-- =========================================================================
CREATE TABLE IF NOT EXISTS support.user_identities (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES support.users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  value       TEXT NOT NULL,
  verified    BOOLEAN NOT NULL DEFAULT false,
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, value)
);

CREATE INDEX IF NOT EXISTS idx_support_identities_user
  ON support.user_identities (user_id);

-- =========================================================================
-- tickets
-- =========================================================================
CREATE TABLE IF NOT EXISTS support.tickets (
  id                 BIGSERIAL PRIMARY KEY,
  legacy_zendesk_id  BIGINT UNIQUE,
  external_id        TEXT,
  requester_id       BIGINT REFERENCES support.users(id),
  assignee_id        BIGINT REFERENCES support.users(id),
  subject            TEXT,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'open',
  priority           TEXT,
  channel            TEXT,
  tags               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  custom_fields      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_requester
  ON support.tickets (requester_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON support.tickets (status);

-- =========================================================================
-- ticket_audits + ticket_events (un audit agrupa N events)
-- =========================================================================
CREATE TABLE IF NOT EXISTS support.ticket_audits (
  id                 BIGSERIAL PRIMARY KEY,
  legacy_zendesk_id  BIGINT UNIQUE,
  ticket_id          BIGINT NOT NULL REFERENCES support.tickets(id) ON DELETE CASCADE,
  author_id          BIGINT REFERENCES support.users(id),
  via                JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_audits_ticket_created
  ON support.ticket_audits (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS support.ticket_events (
  id          BIGSERIAL PRIMARY KEY,
  audit_id    BIGINT NOT NULL REFERENCES support.ticket_audits(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  body        TEXT,
  html_body   TEXT,
  plain_body  TEXT,
  is_public   BOOLEAN NOT NULL DEFAULT true,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_support_events_audit
  ON support.ticket_events (audit_id);

-- =========================================================================
-- Trigger genérico para updated_at
-- =========================================================================
CREATE OR REPLACE FUNCTION support.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_support_users_touch ON support.users;
CREATE TRIGGER trg_support_users_touch
  BEFORE UPDATE ON support.users
  FOR EACH ROW EXECUTE FUNCTION support.touch_updated_at();

DROP TRIGGER IF EXISTS trg_support_identities_touch ON support.user_identities;
CREATE TRIGGER trg_support_identities_touch
  BEFORE UPDATE ON support.user_identities
  FOR EACH ROW EXECUTE FUNCTION support.touch_updated_at();

DROP TRIGGER IF EXISTS trg_support_tickets_touch ON support.tickets;
CREATE TRIGGER trg_support_tickets_touch
  BEFORE UPDATE ON support.tickets
  FOR EACH ROW EXECUTE FUNCTION support.touch_updated_at();
