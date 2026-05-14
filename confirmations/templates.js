/**
 * Definición de los HSM templates de WhatsApp que usa MelanIA.
 *
 * Los nombres y el orden de variables {{1}}, {{2}}, ... deben coincidir
 * EXACTAMENTE con lo registrado en Meta Business Manager. Cambiar el
 * texto en este archivo NO actualiza la plantilla en Meta — la plantilla
 * se vuelve a aprobar manualmente y queda con un sufijo de versión nuevo
 * (ej. `cly_confirm_appointment_v2`).
 *
 * Los nombres son overridables por env var para poder rotar versiones
 * sin redeploy:
 *   - CHATWOOT_HSM_CONFIRM_INITIAL  (default cly_confirm_appointment_v1)
 *   - CHATWOOT_HSM_CONFIRM_REMINDER (default cly_confirm_reminder_76h_v1)
 *
 * Estado 2026-05-13: las 3 plantillas están Activas en Meta BM
 * (cly_confirm_appointment_v1, cly_confirm_reminder_76h_v1 y _v2).
 * Decisión: usar v1 del recordatorio. La _v2 queda como duplicado
 * inactivo, no se referencia.
 *
 * Ver docs/whatsapp-templates.md para los textos canónicos.
 */

export const TEMPLATES = Object.freeze({
  /**
   * Primer mensaje al paciente, apenas se detecta la cita en Medinet.
   *
   * Texto canónico (ver docs/whatsapp-templates.md):
   *   "Hola {{1}}, soy MelanIA de Clínyco 👋. Te confirmamos tu cita
   *    de {{2}} con {{3}} el {{4}} a las {{5}}. ¿CONFIRMAS? Responde
   *    SÍ para confirmar, NO para cancelar, o REAGENDAR si quieres
   *    cambiarla."
   */
  CONFIRM_APPOINTMENT:
    process.env.CHATWOOT_HSM_CONFIRM_INITIAL || "cly_confirm_appointment_v1",

  /**
   * Recordatorio enviado a T-76h antes de la cita (~3 días y 4 horas).
   *
   * Texto canónico (ver docs/whatsapp-templates.md):
   *   "Hola {{1}}, te recordamos tu cita de {{2}} con {{3}} el {{4}} a
   *    las {{5}}. Si necesitas reagendar o cancelar, respóndenos por
   *    aquí. ¡Te esperamos!"
   *
   * Es INFORMATIVO: no re-pide confirmación. Regla de lifecycle:
   * sin respuesta al recordatorio = la cita sigue confirmada (no es
   * un fallo). Solo abre la puerta a cancel/reschedule.
   */
  REMIND_76H:
    process.env.CHATWOOT_HSM_CONFIRM_REMINDER || "cly_confirm_reminder_76h_v1",
});

/**
 * Construye los `processed_params` que espera Chatwoot para inyectar
 * en {{1}}…{{5}} del template de confirmación.
 *
 * @param appointment row de confirmations.appointments
 */
export function buildConfirmParams(appointment) {
  return {
    processed_params: {
      1: shortFirstName(appointment.patient_name),
      2: appointment.specialty || "su atención",
      3: appointment.professional || "su profesional",
      4: formatDate(appointment.appointment_at),
      5: formatTime(appointment.appointment_at),
    },
  };
}

/**
 * Idem para el template de recordatorio T-76h.
 */
export function buildReminderParams(appointment) {
  return {
    processed_params: {
      1: shortFirstName(appointment.patient_name),
      2: appointment.specialty || "su atención",
      3: appointment.professional || "su profesional",
      4: formatDate(appointment.appointment_at),
      5: formatTime(appointment.appointment_at),
    },
  };
}

/**
 * Texto de fallback que va en `content` cuando Chatwoot no puede
 * resolver el template (visibles solo en el panel de agentes — el
 * paciente recibe la plantilla aprobada).
 */
export function buildFallbackText(appointment, kind) {
  const name = shortFirstName(appointment.patient_name);
  const when = `${formatDate(appointment.appointment_at)} ${formatTime(
    appointment.appointment_at
  )}`;
  if (kind === "remind") {
    return `Recordatorio MelanIA: ${name}, te recordamos tu cita de ${
      appointment.specialty || "atención"
    } el ${when}.`;
  }
  return `Confirmación MelanIA: ${name}, te confirmamos tu cita de ${
    appointment.specialty || "atención"
  } el ${when}. Responde SÍ, NO o REAGENDAR.`;
}

function shortFirstName(fullName) {
  if (!fullName) return "Hola";
  return String(fullName).trim().split(/\s+/)[0];
}

function formatDate(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Chile (America/Santiago) DD/MM/YYYY
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
