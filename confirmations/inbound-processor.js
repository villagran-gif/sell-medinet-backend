/**
 * Handler de confirmaciones de citas — consumidor aislado del dispatcher.
 *
 * Sólo actúa cuando existe una cita que está esperando confirmación o
 * recordatorio citado explícitamente en la misma conversación. Si no hay una cita pendiente,
 * sale inmediatamente: no clasifica, no registra y no interfiere con AntonIA.
 *
 * `processInboundQueue` queda como shim deprecado que delega al dispatcher,
 * por compatibilidad de imports.
 */

import { extractAttendanceReply } from "./reply-context.js";
import { classifyInbound, INTENTS } from "./classifier.js";
import {
  findAppointmentByReply,
  applyIntent,
  logClassification,
} from "./lifecycle.js";
import { sendAcknowledgment } from "./acknowledgments.js";

const HANDOFF_TIMEOUT_MS = 8_000;

/**
 * @deprecated El claim + ruteo de la cola ahora vive en chatwoot-dispatcher.
 */
export async function processInboundQueue(opts = {}) {
  const { dispatchPending } = await import("../chatwoot-dispatcher/index.js");
  return dispatchPending(opts);
}

export async function handleInboundEvent(ev) {
  // El evento ya está reclamado por el dispatcher.
  const message = extractAttendanceReply(ev.payload);
  if (!message) {
    return { skipped: true, reason: "not_incoming_message" };
  }

  // Filtro crítico de aislamiento: una conversación normal NO es una
  // confirmación de cita. No clasificar nada si no existe una cita activa
  // esperando respuesta al mensaje citado y para esta versión de la cita.
  const appointment = await findAppointmentByReply(message);
  if (!appointment) {
    return {
      skipped: true,
      reason: "no_pending_confirmation",
      matchedAppointment: false,
    };
  }

  const decision = await classifyInbound(message.content, { appointment });

  await logClassification({
    rawEventId: ev.id,
    appointmentId: appointment.id,
    intent: decision.intent,
    confidence: decision.confidence,
    rawMessage: message.content,
    model: decision.model,
  });

  const updated = await applyIntent(appointment.id, decision.intent, appointment.revision);
  if (!updated) {
    return { classified: true, matchedAppointment: true, acked: false, handoff: false, reason: 'appointment_update_unverified' };
  }

  let handoff = false;
  if (decision.intent === INTENTS.RESCHEDULE) {
    handoff = await triggerRescheduleHandoff(appointment, message);
  }

  // Acuse best-effort dentro de la ventana abierta por el paciente.
  let acked = false;
  try {
    const ackResult = await sendAcknowledgment(updated, decision.intent);
    acked = !!ackResult?.sent;
  } catch (err) {
    console.error(
      `[confirmations/inbound-processor] ack para appointment ${appointment.id} falló:`,
      err.message
    );
  }

  return {
    classified: true,
    matchedAppointment: true,
    handoff,
    acked,
  };
}

/**
 * Si el paciente pide reagendar, deriva al flujo correspondiente en clinyco_AI.
 * Best-effort: si falla, la transición reschedule_requested queda registrada.
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
