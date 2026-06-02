-- 004-chatwoot-source.sql — Espejo de Chatwoot Cloud en support.*
--
-- Aditivo e idempotente. Agrega las columnas e índices únicos que el módulo
-- support-normalizer usa para upsertear por id de Chatwoot. No toca datos
-- existentes (las columnas nuevas quedan NULL en filas del backfill de Zendesk).

ALTER TABLE support.users
  ADD COLUMN IF NOT EXISTS chatwoot_contact_id BIGINT;

ALTER TABLE support.tickets
  ADD COLUMN IF NOT EXISTS chatwoot_conversation_id BIGINT;

-- Unique parcial: permite muchos NULL (filas Zendesk) pero un solo registro por
-- id de Chatwoot. Habilita el ON CONFLICT del upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_users_chatwoot_contact
  ON support.users (chatwoot_contact_id)
  WHERE chatwoot_contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_support_tickets_chatwoot_conversation
  ON support.tickets (chatwoot_conversation_id)
  WHERE chatwoot_conversation_id IS NOT NULL;
