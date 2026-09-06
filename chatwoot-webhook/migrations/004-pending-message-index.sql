-- La cola del dispatcher sólo consume message_created.
-- El índice anterior incluía todos los eventos con processed_at IS NULL y terminó
-- conteniendo cientos de miles de message_updated/typing/contact_updated.
-- Eso obligaba a PostgreSQL a recorrer una cola enorme para encontrar mensajes.

DROP INDEX IF EXISTS chatwoot.idx_raw_events_unprocessed;

CREATE INDEX IF NOT EXISTS idx_raw_events_pending_messages
  ON chatwoot.raw_events (received_at, id)
  WHERE processed_at IS NULL
    AND event_type = 'message_created';

ANALYZE chatwoot.raw_events;
