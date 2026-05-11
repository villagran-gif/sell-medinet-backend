import { getPool } from "./db.js";

/**
 * Estados válidos de una cita en el ciclo MelanIA.
 * Las transiciones permitidas se documentan en confirmations/README.md.
 */
export const STATES = Object.freeze({
  SCHEDULED: "scheduled",
  FIRST_MSG_SENT: "first_msg_sent",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  RESCHEDULE_REQUESTED: "reschedule_requested",
  REMINDER_SENT: "reminder_sent",
  NO_RESPONSE: "no_response",
});

/**
 * Valida y normaliza el payload que llega a POST /confirmations/intake.
 * Lanza Error con .status=400 + .field si algo está mal.
 */
export function validateIntakePayload(body) {
  if (!body || typeof body !== "object") {
    throw badRequest("payload", "body debe ser un objeto JSON");
  }

  const externalId = Number(body.external_id);
  if (!Number.isFinite(externalId) || externalId <= 0) {
    throw badRequest("external_id", "requerido, entero positivo");
  }

  const branchId = Number(body.branch_id);
  if (!Number.isFinite(branchId)) {
    throw badRequest("branch_id", "requerido, entero");
  }

  const appointmentAtRaw = body.appointment_at;
  const appointmentAt = appointmentAtRaw ? new Date(appointmentAtRaw) : null;
  if (!appointmentAt || Number.isNaN(appointmentAt.getTime())) {
    throw badRequest("appointment_at", "requerido, ISO-8601 parseable por Date");
  }

  const patient = body.patient || {};
  const phone = String(patient.phone || "").trim();
  if (!phone) {
    throw badRequest("patient.phone", "requerido");
  }

  return {
    externalId,
    branchId,
    branchName: stringOrNull(body.branch_name),
    specialty: stringOrNull(body.specialty),
    professional: stringOrNull(body.professional),
    appointmentAt,
    durationMin: numberOrNull(body.duration_min),
    medinetState: stringOrNull(body.medinet_state),
    patientRun: stringOrNull(patient.run),
    patientName: stringOrNull(patient.name),
    patientPhone: phone,
    patientEmail: stringOrNull(patient.email),
    raw: body.raw ?? body,
  };
}

/**
 * Upsert por external_id. Idempotente — clinyco_AI puede reenviar
 * la misma cita N veces sin duplicar ni resetear el estado.
 *
 * - Si es nueva: inserta con state='scheduled'.
 * - Si ya existe: actualiza campos mutables (appointment_at, medinet_state,
 *   datos de contacto, raw) pero NO toca state ni los timestamps de
 *   first_msg_sent_at/reminder_sent_at — esos son del flujo interno.
 *
 * Returns: { row, created: boolean }
 */
export async function upsertAppointment(normalized) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    INSERT INTO confirmations.appointments (
      external_id, branch_id, branch_name, specialty, professional,
      appointment_at, duration_min, medinet_state,
      patient_run, patient_name, patient_phone, patient_email,
      raw, state
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14
    )
    ON CONFLICT (external_id) DO UPDATE SET
      branch_id       = EXCLUDED.branch_id,
      branch_name     = EXCLUDED.branch_name,
      specialty       = EXCLUDED.specialty,
      professional    = EXCLUDED.professional,
      appointment_at  = EXCLUDED.appointment_at,
      duration_min    = EXCLUDED.duration_min,
      medinet_state   = EXCLUDED.medinet_state,
      patient_run     = EXCLUDED.patient_run,
      patient_name    = EXCLUDED.patient_name,
      patient_phone   = EXCLUDED.patient_phone,
      patient_email   = EXCLUDED.patient_email,
      raw             = EXCLUDED.raw,
      updated_at      = now()
    RETURNING
      id, external_id, state, created_at, updated_at,
      (xmax = 0) AS created
    `,
    [
      normalized.externalId,
      normalized.branchId,
      normalized.branchName,
      normalized.specialty,
      normalized.professional,
      normalized.appointmentAt,
      normalized.durationMin,
      normalized.medinetState,
      normalized.patientRun,
      normalized.patientName,
      normalized.patientPhone,
      normalized.patientEmail,
      normalized.raw,
      STATES.SCHEDULED,
    ]
  );
  const row = rows[0];
  return { row, created: row.created === true };
}

function stringOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function badRequest(field, message) {
  const err = new Error(`${field}: ${message}`);
  err.status = 400;
  err.field = field;
  return err;
}
