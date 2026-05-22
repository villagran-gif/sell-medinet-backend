/**
 * Mensajes de acuse de recibo que MelanIA envía al paciente DESPUÉS
 * de procesar su respuesta al HSM inicial.
 *
 * Se envían como texto libre (no template) porque la ventana 24h ya
 * está abierta — el paciente acaba de responder al HSM. Es lo que
 * cierra el bucle UX: el paciente sabe que su acción fue procesada.
 *
 * Llamado desde inbound-processor.js::triggerAck después de applyIntent.
 */

import { sendTextMessage } from "./chatwoot-client.js";
import { branchExtras, branchMapLink } from "./branch-info.js";

/**
 * Construye y envía el acuse al paciente.
 *
 * @param {object} appointment  row de confirmations.appointments (después
 *                              de applyIntent, con state actualizado)
 * @param {string} intent       confirm | cancel | reschedule | other | ambiguous
 *
 * Si la cita no tiene chatwoot_conversation_id (raro pero posible si el
 * 1er mensaje se mandó sin guardar conv), skip silencioso.
 */
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
 * Genera el texto del ack según el intent. Exportada para tests.
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
      return buildAmbiguousAck(name);
    default:
      return null;
  }
}

function buildConfirmAck(appointment, name) {
  const lines = [`¡Perfecto ${name}! ✅ Tu cita queda confirmada.`, ""];

  // Detalles
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

  // Sucursal + dirección
  if (appointment.branch_name) {
    lines.push(`📍 ${appointment.branch_name}`);
  }
  if (appointment.branch_address) {
    lines.push(appointment.branch_address);
  }
  const map = branchMapLink(appointment.branch_id);
  if (map) {
    lines.push(`🗺️ Cómo llegar: ${map}`);
  }

  // Extras de sucursal (parking, accesos, etc.)
  const extras = branchExtras(appointment.branch_id);
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
  // Por ahora solo acuse. La Fase 1b va a reemplazar este texto por la
  // lista real de slots disponibles consultados a Medinet en vivo.
  return (
    `Entendido ${name}. Déjame buscar opciones disponibles 🔍\n\n` +
    `En instantes te paso las próximas fechas en que podríamos reagendar tu cita.`
  );
}

function buildAmbiguousAck(name) {
  return (
    `No entendí tu mensaje 🤔. Por favor responde:\n\n` +
    `✅ SÍ para confirmar\n` +
    `❌ NO para cancelar\n` +
    `📅 REAGENDAR para cambiar fecha`
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
