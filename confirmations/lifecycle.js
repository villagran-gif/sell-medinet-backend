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

/**
 * Busca la cita "más relevante" para un teléfono que acaba de mandar
 * un mensaje. Heurística: la cita futura más cercana (o pasada por menos
 * de 24h) que esté en un estado donde tiene sentido recibir respuesta.
 *
 * Devuelve null si no hay match — entonces el mensaje no se asocia a
 * ninguna cita (clasifica igual y queda registrado en inbound_classifications
 * para auditoría).
 */
export async function findAppointmentByInboundPhone(phone) {
  if (!phone) return null;
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT *
    FROM confirmations.appointments
    WHERE patient_phone = $1
      AND state IN ('first_msg_sent', 'reminder_sent', 'confirmed',
                    'reschedule_requested', 'scheduled')
      AND appointment_at > now() - interval '24 hours'
    ORDER BY appointment_at ASC
    LIMIT 1
    `,
    [phone]
  );
  return rows[0] || null;
}

/**
 * Aplica una intención clasificada a una cita y registra la transición.
 * Transiciones del state machine MelanIA:
 *
 *   confirm     →  state = 'confirmed'
 *   cancel      →  state = 'cancelled'
 *   reschedule  →  state = 'reschedule_requested' (lifecycle externo:
 *                  el caller debe hacer handoff HTTP a clinyco_AI)
 *   other       →  sin cambio de estado, solo bump last_inbound_at
 *   ambiguous   →  sin cambio de estado, solo bump last_inbound_at
 *
 * Returns el row actualizado.
 */
export async function applyIntent(appointmentId, intent) {
  const pool = getPool();
  const nextState = intentToState(intent);
  const sql = nextState
    ? `UPDATE confirmations.appointments
         SET state = $2, last_inbound_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`
    : `UPDATE confirmations.appointments
         SET last_inbound_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`;
  const params = nextState ? [appointmentId, nextState] : [appointmentId];
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

function intentToState(intent) {
  switch (intent) {
    case "confirm":
      return STATES.CONFIRMED;
    case "cancel":
      return STATES.CANCELLED;
    case "reschedule":
      return STATES.RESCHEDULE_REQUESTED;
    default:
      return null;
  }
}

/**
 * Marca first_msg_sent_at + transiciona scheduled→first_msg_sent y
 * guarda los ids de Chatwoot. Idempotente: no pisa first_msg_sent_at
 * si ya está seteado.
 */
export async function markFirstMessageSent({
  appointmentId,
  chatwootContactId,
  chatwootConversationId,
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    UPDATE confirmations.appointments
       SET state = CASE WHEN state = 'scheduled' THEN 'first_msg_sent' ELSE state END,
           first_msg_sent_at = COALESCE(first_msg_sent_at, now()),
           chatwoot_contact_id = COALESCE(chatwoot_contact_id, $2),
           chatwoot_conversation_id = COALESCE(chatwoot_conversation_id, $3),
           updated_at = now()
     WHERE id = $1
     RETURNING *
    `,
    [appointmentId, chatwootContactId, chatwootConversationId]
  );
  return rows[0] || null;
}

/**
 * Marca reminder_sent_at + transiciona a 'reminder_sent' si la cita
 * estaba en first_msg_sent. Si ya estaba confirmed, deja el estado
 * pero sí marca el timestamp para no reenviar.
 */
export async function markReminderSent({ appointmentId }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    UPDATE confirmations.appointments
       SET state = CASE WHEN state = 'first_msg_sent' THEN 'reminder_sent' ELSE state END,
           reminder_sent_at = COALESCE(reminder_sent_at, now()),
           updated_at = now()
     WHERE id = $1
     RETURNING *
    `,
    [appointmentId]
  );
  return rows[0] || null;
}

/**
 * Registra una decisión del classifier en inbound_classifications.
 */
export async function logClassification({
  rawEventId,
  appointmentId,
  intent,
  confidence,
  rawMessage,
  model,
}) {
  const pool = getPool();
  await pool.query(
    `
    INSERT INTO confirmations.inbound_classifications
      (raw_event_id, appointment_id, intent, confidence, raw_message, model)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [rawEventId, appointmentId, intent, confidence, rawMessage, model]
  );
}

/**
 * Registra un envío outbound (template HSM). El UNIQUE parcial sobre
 * (appointment_id, template_name) WHERE error IS NULL hace que un
 * envío exitoso bloquee reenvíos del mismo template — idempotencia.
 */
export async function logOutbound({
  appointmentId,
  templateName,
  templateParams,
  chatwootMessageId,
  dryRun,
  error,
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    INSERT INTO confirmations.outbound_messages
      (appointment_id, template_name, template_params, chatwoot_message_id, dry_run, error)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (appointment_id, template_name) WHERE error IS NULL
      DO NOTHING
    RETURNING id
    `,
    [
      appointmentId,
      templateName,
      templateParams ? JSON.stringify(templateParams) : null,
      chatwootMessageId,
      !!dryRun,
      error || null,
    ]
  );
  return rows[0]?.id || null;
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
