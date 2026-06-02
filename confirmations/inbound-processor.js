/**
 * Handler MelanIA de confirmaciones — un consumidor del chatwoot-dispatcher.
 *
 * `handleInboundEvent(ev)` recibe un `message_created` ya reclamado por el
 * dispatcher (que es quien posee el claim FOR UPDATE SKIP LOCKED y el cursor
 * `processed_at`). Filtra mensajes incoming, los clasifica con Haiku 4.5 y
 * aplica la transición correspondiente en `confirmations.appointments`.
 *
 * `processInboundQueue` queda como shim deprecado que delega al dispatcher,
 * por compatibilidad de imports.
 */

import { classifyInbound, INTENTS } from "./classifier.js";
import {
  findAppointmentByInboundPhone,
  applyIntent,
  logClassification,
} from "./lifecycle.js";
import { sendAcknowledgment } from "./acknowledgments.js";

const HANDOFF_TIMEOUT_MS = 8_000;

/**
 * @deprecated El claim + ruteo de la cola ahora vive en chatwoot-dispatcher.
 * Este shim se mantiene por compatibilidad de imports y delega al dispatcher,
 * que rutea a este módulo vía el handler "melania" (default). Ver
 * chatwoot-dispatcher/README.md.
 */
export async function processInboundQueue(opts = {}) {
  const { dispatchPending } = await import("../chatwoot-dispatcher/index.js");
  return dispatchPending(opts);
}

export async function handleInboundEvent(ev) {
  // Nota: el evento YA está marcado como processed por el atomic claim
  // del chatwoot-dispatcher. No re-marcamos processed_at acá.
  const message = extractMessage(ev.payload);
  if (!message) {
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
  let acked = false;
  if (appointment) {
    const updated = await applyIntent(appointment.id, decision.intent);
    if (decision.intent === INTENTS.RESCHEDULE) {
      handoff = await triggerRescheduleHandoff(appointment, message);
    }
    // Acuse al paciente — texto plano en la conversación (ventana 24h
    // ya abierta porque el paciente acaba de responder). Best-effort:
    // si falla, queda registrada la transición igual.
    try {
      const ackResult = await sendAcknowledgment(updated || appointment, decision.intent);
      acked = !!ackResult?.sent;
    } catch (err) {
      console.error(
        `[confirmations/inbound-processor] ack para appointment ${appointment.id} falló:`,
        err.message
      );
    }
  }

  return {
    classified: true,
    matchedAppointment: !!appointment,
    handoff,
    acked,
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
