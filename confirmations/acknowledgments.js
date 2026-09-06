/**
 * Acuses del flujo simple de confirmaciones de cita.
 *
 * Sólo confirm/cancel/reschedule generan respuesta. Mensajes ambiguos u otras
 * preguntas no deben ser contestados por este módulo para no interferir con
 * AntonIA ni con un agente humano.
 */

import { sendTextMessage } from "./chatwoot-client.js";

const BRANCH_EXTRAS = {
  39: "🅿️ Contamos con 150 estacionamientos subterráneos (ingreso al final de la calle lateral).",
};

export async function sendAcknowledgment(appointment, intent) {
  if (!appointment?.chatwoot_conversation_id) {
    console.warn(
      `[confirmations/ack] appointment ${appointment?.id} sin chatwoot_conversation_id, skip ack`
    );
    return { skipped: true };
  }

  const content = buildAckText(appointment, intent);
  if (!content) {
    return { skipped: true, reason: `intent ${intent} sin ack definido` };
  }

  try {
    const r = await sendTextMessage({
      conversationId: appointment.chatwoot_conversation_id,
      content,
    });
    return { sent: true, messageId: r.messageId };
  } catch (err) {
    console.error(
      `[confirmations/ack] sendTextMessage falló para appointment ${appointment.id}:`,
      err.message
    );
    return { sent: false, error: err.message };
  }
}

/**
 * Sólo tres intenciones tienen respuesta automática.
 */
export function buildAckText(appointment, intent) {
  const name = shortFirstName(appointment.patient_name);

  switch (intent) {
    case "confirm":
      return buildConfirmAck(appointment, name);
    case "cancel":
      return buildCancelAck(name);
    case "reschedule":
      return buildRescheduleAck(name);
    case "ambiguous":
    case "other":
    default:
      return null;
  }
}

function buildConfirmAck(appointment, name) {
  const lines = [`¡Perfecto ${name}! ✅ Tu cita queda confirmada.`, ""];

  const when = `${formatDate(appointment.appointment_at)} a las ${formatTime(
    appointment.appointment_at
  )}`;
  lines.push(`📅 ${when}`);

  if (appointment.specialty || appointment.professional) {
    const parts = [];
    if (appointment.specialty) parts.push(appointment.specialty);
    if (appointment.professional) parts.push(`con ${appointment.professional}`);
    lines.push(`🩺 ${parts.join(" ")}`);
  }

  if (appointment.branch_name) lines.push(`📍 ${appointment.branch_name}`);
  if (appointment.branch_address) lines.push(appointment.branch_address);

  const extras = BRANCH_EXTRAS[appointment.branch_id];
  if (extras) {
    lines.push("");
    lines.push(extras);
  }

  lines.push("");
  lines.push("Te esperamos.");
  return lines.join("\n");
}

function buildCancelAck(name) {
  return (
    `Listo ${name}, tu cita queda cancelada ❌.\n\n` +
    `Si necesitas reagendar puedes entrar a clinyco.cl/agenda o responder por aquí.`
  );
}

function buildRescheduleAck(name) {
  return (
    `Entendido ${name}. Déjame buscar opciones disponibles 🔍\n\n` +
    `En instantes te paso las próximas fechas en que podríamos reagendar tu cita.`
  );
}

function shortFirstName(fullName) {
  if (!fullName) return "Hola";
  return String(fullName).trim().split(/\s+/)[0];
}

function formatDate(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatTime(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es-CL", {
    timeZone: "America/Santiago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
