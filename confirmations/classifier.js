/**
 * Clasificador determinista de respuestas a confirmaciones de cita.
 *
 * Este módulo NO usa IA generativa. El flujo de confirmaciones debe ser
 * pequeño, barato y aislado de AntonIA: confirmar / cancelar / reagendar /
 * otro / ambiguo.
 */

export const INTENTS = Object.freeze({
  CONFIRM: "confirm",
  CANCEL: "cancel",
  RESCHEDULE: "reschedule",
  OTHER: "other",
  AMBIGUOUS: "ambiguous",
});

/**
 * Clasifica un mensaje de paciente con reglas locales.
 * `_opts` se conserva por compatibilidad con el caller actual.
 *
 * @returns {Promise<{intent: string, confidence: number, model: string}>}
 */
export async function classifyInbound(message, _opts = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return { intent: INTENTS.AMBIGUOUS, confidence: 0, model: "empty" };
  }

  return { ...heuristic(text), model: "deterministic" };
}

function heuristic(text) {
  const t = normalize(text);

  // Reagendar antes que cancelar: "no puedo, cámbiamela" es reschedule.
  if (
    /\b(reagendar|reagendo|reprogramar|cambiar|cambio|mover|posponer|pasar)\b/.test(t) &&
    /\b(hora|cita|fecha|dia|semana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|mañana|manana|tarde|temprano|despues|proxima|proximo|otra|otro)\b/.test(t)
  ) {
    return { intent: INTENTS.RESCHEDULE, confidence: 0.95 };
  }
  if (/\b(reagendar|reprogramar|otra hora|otra fecha|otro dia|cambiar la hora|cambiar hora|mover la hora|posponer)\b/.test(t)) {
    return { intent: INTENTS.RESCHEDULE, confidence: 0.95 };
  }

  // Confirmaciones comunes de WhatsApp.
  if (
    /^(si|sí|sip|sipo|ok|okay|dale|claro|confirmo|confirmado|confirmada|voy|asistire|asistiré|ahi estare|ahí estaré|alli estare|allí estaré|perfecto|de acuerdo|nos vemos)$/i.test(text.trim()) ||
    /^(👍|✅|👌|🙌)$/u.test(text.trim()) ||
    /\b(confirmo|confirmada?|asistire|asistiré|ahi estare|ahí estaré|alli estare|allí estaré|si voy|sí voy|nos vemos)\b/.test(t)
  ) {
    return { intent: INTENTS.CONFIRM, confidence: 0.95 };
  }

  // Cancelación inequívoca.
  if (
    /\b(cancelar|cancelo|cancela|anular|anulo|anula|no asistire|no asistiré|no voy|ya no voy)\b/.test(t) ||
    /^(no|nop|no gracias)$/i.test(text.trim())
  ) {
    return { intent: INTENTS.CANCEL, confidence: 0.9 };
  }

  // Preguntas relacionadas con la cita: no cambian su estado.
  if (
    /[?¿]/.test(text) ||
    /\b(donde|dónde|direccion|dirección|valor|precio|costo|cuanto|cuánto|estacionamiento|documentos|llevar|ayuno|ubicacion|ubicación)\b/.test(t)
  ) {
    return { intent: INTENTS.OTHER, confidence: 0.85 };
  }

  // Respuestas demasiado cortas o sin intención clara no deben cambiar la cita.
  return { intent: INTENTS.AMBIGUOUS, confidence: 0.4 };
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
