-- Historical sends intentionally have no context: do not infer an association.
ALTER TABLE confirmations.appointments ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE confirmations.outbound_messages ADD COLUMN IF NOT EXISTS appointment_revision bigint;
ALTER TABLE confirmations.outbound_messages ADD COLUMN IF NOT EXISTS chatwoot_conversation_id bigint;
ALTER TABLE confirmations.outbound_messages ADD COLUMN IF NOT EXISTS chatwoot_inbox_id bigint;

CREATE OR REPLACE FUNCTION confirmations.bump_appointment_revision() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.appointment_at, NEW.branch_id, NEW.professional, NEW.specialty,
         NEW.patient_phone, NEW.patient_run, NEW.medinet_state)
     IS DISTINCT FROM
     ROW(OLD.appointment_at, OLD.branch_id, OLD.professional, OLD.specialty,
         OLD.patient_phone, OLD.patient_run, OLD.medinet_state) THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS attendance_revision ON confirmations.appointments;
CREATE TRIGGER attendance_revision BEFORE UPDATE ON confirmations.appointments
FOR EACH ROW EXECUTE FUNCTION confirmations.bump_appointment_revision();
