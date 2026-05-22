-- confirmations/migrations/003-multi-reminders.sql
--
-- Rediseño de recordatorios: de 1 (T-76h) a 3 (T-72h, T-24h, T-4h).
-- Cada uno se trackea por separado para idempotencia independiente.
--
-- La columna vieja reminder_sent_at queda (no se borra) por compatibilidad
-- y para no perder el historial de lo ya enviado. El scheduler nuevo usa
-- las 3 columnas nuevas.

ALTER TABLE confirmations.appointments
  ADD COLUMN IF NOT EXISTS reminder_72h_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_4h_sent_at  TIMESTAMPTZ;

-- Índices parciales para que el scheduler encuentre rápido los pendientes
-- de cada ventana sin escanear toda la tabla.
CREATE INDEX IF NOT EXISTS idx_appointments_pending_72h
  ON confirmations.appointments (appointment_at)
  WHERE reminder_72h_sent_at IS NULL
    AND state IN ('first_msg_sent', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_appointments_pending_24h
  ON confirmations.appointments (appointment_at)
  WHERE reminder_24h_sent_at IS NULL
    AND state IN ('first_msg_sent', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_appointments_pending_4h
  ON confirmations.appointments (appointment_at)
  WHERE reminder_4h_sent_at IS NULL
    AND state IN ('first_msg_sent', 'confirmed');
