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

import { branchMapLink } from "./branch-info.js";

export const TEMPLATES = Object.freeze({
  /**
   * Primer mensaje al paciente, apenas se detecta la cita en Medinet.
   * Vars: {{1}} nombre, {{2}} especialidad, {{3}} profesional,
   *       {{4}} fecha, {{5}} hora.
   */
  CONFIRM_APPOINTMENT:
    process.env.CHATWOOT_HSM_CONFIRM_INITIAL || "cly_confirm_appointment_v1",

  /**
   * Recordatorio único (mismo template para T-72h, T-24h y T-4h). El
   * timeframe ("en 3 días" / "mañana" / "hoy") va como variable, así un
   * solo template aprobado en Meta cubre las 3 ventanas.
   *
   * Texto canónico (ver docs/whatsapp-templates.md), 7 variables:
   *   "Hola {{1}}, te recordamos tu cita de {{2}} con {{3}}, {{4}}.
   *    📅 {{5}}
   *    📍 {{6}}
   *    🗺️ Cómo llegar: {{7}}
   *    Si necesitas reagendar o cancelar, respóndenos por aquí. ¡Te esperamos!"
   */
  REMINDER:
    process.env.CHATWOOT_HSM_REMINDER || "cly_recordatorio_v1",
});

/**
 * Construye los `processed_params` del template de confirmación (5 vars).
 */
export function buildConfirmParams(appointment) {
  return {
    processed_params: {
      body: {
        1: shortFirstName(appointment.patient_name),
        2: appointment.specialty || "su atención",
        3: appointment.professional || "su profesional",
        4: formatDate(appointment.appointment_at),
        5: formatTime(appointment.appointment_at),
      },
    },
  };
}

/**
 * Construye los `processed_params` del template de recordatorio (7 vars).
 * El `timeframe` lo pasa el scheduler según la ventana (72h/24h/4h).
 *
 * Dirección viene de branch_address (Medinet). Map link de branch-info.
 * Para telemedicina (sin dirección/mapa) se usan fallbacks.
 */
export function buildReminderParams(appointment, timeframe) {
  const address =
    appointment.branch_address ||
    (isTelemedicina(appointment) ? "Atención por Telemedicina" : (appointment.branch_name || "Clínyco"));
  const map = branchMapLink(appointment.branch_id) || "https://clinyco.cl";

  return {
    processed_params: {
      body: {
        1: shortFirstName(appointment.patient_name),
        2: appointment.specialty || "su atención",
        3: appointment.professional || "su profesional",
        4: timeframe || "próximamente",
        5: `${formatDate(appointment.appointment_at)} a las ${formatTime(appointment.appointment_at)}`,
        6: address,
        7: map,
      },
    },
  };
}

/**
 * Texto de fallback (panel de agentes — el paciente recibe el HSM).
 */
export function buildFallbackText(appointment, kind, timeframe) {
  const name = shortFirstName(appointment.patient_name);
  const when = `${formatDate(appointment.appointment_at)} ${formatTime(
    appointment.appointment_at
  )}`;
  if (kind === "remind") {
    return `Recordatorio MelanIA: ${name}, te recordamos tu cita de ${
      appointment.specialty || "atención"
    } (${timeframe || ""}) el ${when}.`;
  }
  return `Confirmación MelanIA: ${name}, te confirmamos tu cita de ${
    appointment.specialty || "atención"
  } el ${when}. Responde SÍ, NO o REAGENDAR.`;
}

function isTelemedicina(appointment) {
  return [2, 3].includes(Number(appointment.branch_id));
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
