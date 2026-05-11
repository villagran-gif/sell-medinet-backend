/**
 * Clasificador de respuestas del paciente vía Claude Haiku 4.5.
 *
 * Toma el texto que el paciente envió por WhatsApp (recibido vía
 * Chatwoot webhook → chatwoot.raw_events) y devuelve la intención
 * dentro de la taxonomía cerrada del flujo MelanIA.
 *
 * Sin nuevas dependencias: fetch nativo contra api.anthropic.com.
 *
 * Modo dry-run / heurístico:
 *   - Si ANTHROPIC_API_KEY no está seteada, o
 *   - Si CONFIRMATIONS_CLASSIFIER_DRY_RUN=true,
 * cae a un matcher por palabras clave. Útil para tests locales y para
 * el primer despliegue antes de habilitar tráfico LLM real.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CONFIRMATIONS_CLASSIFIER_MODEL || "claude-haiku-4-5-20251001";

export const INTENTS = Object.freeze({
  CONFIRM: "confirm",
  CANCEL: "cancel",
  RESCHEDULE: "reschedule",
  OTHER: "other",
  AMBIGUOUS: "ambiguous",
});

const SYSTEM_PROMPT = `Eres MelanIA, asistente de Clínyco que clasifica respuestas de pacientes a confirmaciones de cita médica enviadas por WhatsApp.

Tu única tarea es decidir la intención del paciente entre estas 5 categorías:
- "confirm": el paciente confirma que asistirá ("sí", "ok", "confirmo", "ahí estaré", "👍").
- "cancel": el paciente cancela ("no", "no puedo ir", "anula", "ya no").
- "reschedule": el paciente quiere cambiar fecha/hora ("reagendar", "¿puedo cambiarla?", "otro día").
- "other": el mensaje es relevante a la cita pero no encaja en las tres anteriores (pregunta de dirección, costo, etc.).
- "ambiguous": no hay forma razonable de decidir.

Responde SOLO con un JSON válido sin texto adicional ni markdown:
{"intent": "...", "confidence": 0.0-1.0}

Ejemplos:
Paciente: "Sí, ahí estaré gracias"        → {"intent":"confirm","confidence":0.97}
Paciente: "No, no podré asistir"           → {"intent":"cancel","confidence":0.96}
Paciente: "puedo cambiarla a otro día?"    → {"intent":"reschedule","confidence":0.94}
Paciente: "cuanto cuesta la consulta?"     → {"intent":"other","confidence":0.9}
Paciente: "👍"                              → {"intent":"confirm","confidence":0.85}
Paciente: "ok"                              → {"intent":"confirm","confidence":0.8}
Paciente: "ya"                              → {"intent":"ambiguous","confidence":0.5}
Paciente: "REAGENDAR"                       → {"intent":"reschedule","confidence":0.99}
Paciente: "no puedo, ¿se puede pasar para la próxima semana?" → {"intent":"reschedule","confidence":0.92}`;

/**
 * Clasifica un mensaje de paciente. Nunca lanza por errores de LLM:
 * en caso de fallo cae al matcher heurístico y reporta `model:"fallback"`.
 *
 * @param {string} message  texto crudo del paciente
 * @param {object} [opts]
 * @param {object} [opts.appointment]  contexto opcional (no se inyecta al
 *   prompt todavía — reservado para una iteración futura si necesitamos
 *   desambiguar respuestas tipo "el lunes mejor").
 *
 * @returns {Promise<{intent: string, confidence: number, model: string, raw?: string}>}
 */
export async function classifyInbound(message, _opts = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return { intent: INTENTS.AMBIGUOUS, confidence: 0, model: "empty" };
  }

  if (isDryRun()) {
    return { ...heuristic(text), model: "heuristic" };
  }

  try {
    const result = await classifyViaAnthropic(text);
    return result;
  } catch (err) {
    console.error("[confirmations/classifier] anthropic failed, falling back:", err.message);
    return { ...heuristic(text), model: "fallback" };
  }
}

function isDryRun() {
  if (process.env.CONFIRMATIONS_CLASSIFIER_DRY_RUN === "true") return true;
  if (!process.env.ANTHROPIC_API_KEY) return true;
  return false;
}

async function classifyViaAnthropic(text) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 64,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Paciente: ${text}` }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const content = (json?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const parsed = parseJsonStrict(content);
  if (!parsed) {
    throw new Error(`unparseable model output: ${content.slice(0, 200)}`);
  }

  const intent = normalizeIntent(parsed.intent);
  const confidence = clamp01(Number(parsed.confidence));
  return { intent, confidence, model: MODEL, raw: content };
}

function parseJsonStrict(s) {
  try {
    return JSON.parse(s);
  } catch {
    // Permitimos un pequeño envoltorio de markdown por si el modelo se desliza.
    const m = /\{[\s\S]*\}/.exec(s);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function normalizeIntent(v) {
  const s = String(v || "").toLowerCase().trim();
  return Object.values(INTENTS).includes(s) ? s : INTENTS.AMBIGUOUS;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Fallback determinista por keywords. Cubre las respuestas más comunes
 * (>80% de los casos según los logs históricos de CEROAI). Suficiente
 * para que el flujo no se cuelgue cuando el LLM no esté disponible.
 */
function heuristic(text) {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // sin acentos

  if (/\b(reagendar|cambiar|reprogramar|otro dia|otra hora|otra fecha|posponer)\b/.test(t)) {
    return { intent: INTENTS.RESCHEDULE, confidence: 0.85 };
  }
  if (/\b(si|sip|claro|ok|dale|confirmo|ahi estare|alli estare|asistire|voy|confirmada?)\b/.test(t) || /^(👍|✅|si\b)/.test(t)) {
    return { intent: INTENTS.CONFIRM, confidence: 0.8 };
  }
  if (/\b(no|cancel(ar|o|a)|anular|anula|ya no|no puedo|no podre|no asistire)\b/.test(t)) {
    return { intent: INTENTS.CANCEL, confidence: 0.8 };
  }
  return { intent: INTENTS.AMBIGUOUS, confidence: 0.4 };
}
