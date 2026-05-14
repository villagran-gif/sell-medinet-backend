/**
 * Procesador de cola de mensajes inbound desde Chatwoot.
 *
 * Lee `chatwoot.raw_events` (poblada por el módulo chatwoot-webhook),
 * filtra eventos `message_created` con dirección incoming, clasifica
 * el texto con Haiku 4.5 y aplica la transición correspondiente en
 * `confirmations.appointments`.
 *
 * Diseño: pull desacoplado del POST del webhook — el receiver responde
 * 200 rápido y este procesador trabaja con cursor `processed_at IS NULL`.
 *
 * Idempotente: el UPDATE de processed_at usa el mismo id que se leyó,
 * y los inserts en inbound_classifications no son únicos (un raw_event
 * puede tener múltiples ejecuciones — la última es la fuente de verdad,
 * pero el log queda para auditoría).
 */

import { getPool } from "./db.js";
import { classifyInbound, INTENTS } from "./classifier.js";
import {
  findAppointmentByInboundPhone,
  applyIntent,
  logClassification,
} from "./lifecycle.js";

const HANDOFF_TIMEOUT_MS = 8_000;

/**
 * Procesa hasta `limit` eventos pendientes. Devuelve un resumen.
 */
export async function processInboundQueue({ limit = 50 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT id, event_type, payload
      FROM chatwoot.raw_events
     WHERE processed_at IS NULL
       AND event_type = 'message_created'
     ORDER BY received_at ASC
     LIMIT $1
    `,
    [limit]
  );

  const summary = {
    scanned: rows.length,
    classified: 0,
    matched: 0,
    handoffs: 0,
    skipped: 0,
    errors: 0,
  };

  for (const ev of rows) {
    try {
      const result = await processOne(ev);
      if (result.skipped) summary.skipped++;
      if (result.classified) summary.classified++;
      if (result.matchedAppointment) summary.matched++;
      if (result.handoff) summary.handoffs++;
    } catch (err) {
      summary.errors++;
      await markProcessed(ev.id, err.message);
      console.error(
        `[confirmations/inbound-processor] event ${ev.id} failed:`,
        err.message
      );
    }
  }
  return summary;
}

async function processOne(ev) {
  const message = extractMessage(ev.payload);
  if (!message) {
    await markProcessed(ev.id, null);
    return { skipped: true };
  }

  const appointment = await findAppointmentByInboundPhone(message.phone);
  const decision = await classifyInbound(message.content, { appointment });

  await logClassification({
    rawEventId: ev.id,
    appointmentId: appointment?.id ?? null,
    intent: decision.intent,
    confidence: decision.confidence,
    rawMessage: message.content,
    model: decision.model,
  });

  let handoff = false;
  if (appointment) {
    await applyIntent(appointment.id, decision.intent);
    if (decision.intent === INTENTS.RESCHEDULE) {
      handoff = await triggerRescheduleHandoff(appointment, message);
    }
  }

  await markProcessed(ev.id, null);
  return {
    classified: true,
    matchedAppointment: !!appointment,
    handoff,
  };
}

/**
 * Extrae phone + content del payload de Chatwoot `message_created`.
 * Solo procesa mensajes incoming (del paciente), no echoes del bot.
 *
 * Estructura típica (resumida):
 *   {
 *     event: "message_created",
 *     message_type: "incoming",
 *     content: "Sí, ahí estaré",
 *     sender: { phone_number: "+56912345678", ... },
 *     conversation: { id: 123, ... }
 *   }
 */
function extractMessage(payload) {
  if (!payload) return null;
  if (payload.message_type && payload.message_type !== "incoming") return null;

  const content = String(payload.content || "").trim();
  if (!content) return null;

  const phone =
    payload?.sender?.phone_number ||
    payload?.conversation?.meta?.sender?.phone_number ||
    null;
  if (!phone) return null;

  return {
    phone: String(phone).trim(),
    content,
    conversationId: payload?.conversation?.id ?? null,
  };
}

async function markProcessed(rawEventId, error) {
  const pool = getPool();
  await pool.query(
    `
    UPDATE chatwoot.raw_events
       SET processed_at = now(),
           error = $2
     WHERE id = $1
    `,
    [rawEventId, error]
  );
}

/**
 * Notifica a clinyco_AI (VPS chileno) que el paciente quiere reagendar.
 * El endpoint /melania/start-from-confirmation arranca el flujo Antonia
 * con el contexto de la cita actual.
 *
 * Best-effort: si falla, queda registrada la transición a
 * reschedule_requested igual, y el siguiente tick puede reintentar.
 */
async function triggerRescheduleHandoff(appointment, message) {
  const baseUrl = process.env.CLINYCO_AI_BASE_URL;
  const token = process.env.CLINYCO_AI_HANDOFF_TOKEN;
  if (!baseUrl || !token) {
    console.warn(
      "[confirmations/inbound-processor] handoff skipped — falta CLINYCO_AI_BASE_URL/CLINYCO_AI_HANDOFF_TOKEN"
    );
    return false;
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/melania/start-from-confirmation`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          external_id: appointment.external_id,
          branch_id: appointment.branch_id,
          patient: {
            run: appointment.patient_run,
            phone: appointment.patient_phone,
            name: appointment.patient_name,
          },
          appointment_at: appointment.appointment_at,
          specialty: appointment.specialty,
          professional: appointment.professional,
          inbound_message: message.content,
          chatwoot_conversation_id: message.conversationId,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(
          `[confirmations/inbound-processor] handoff ${res.status}: ${(await res.text()).slice(0, 200)}`
        );
        return false;
      }
      return true;
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    console.warn("[confirmations/inbound-processor] handoff fetch failed:", err.message);
    return false;
  }
}
