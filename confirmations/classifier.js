/**
 * Clasificador de respuestas del paciente vía OpenAI.
 *
 * Toma el texto que el paciente envió por WhatsApp (recibido vía
 * Chatwoot webhook → chatwoot.raw_events) y devuelve la intención
 * dentro de la taxonomía cerrada del flujo MelanIA.
 *
 * Sin nuevas dependencias: fetch nativo contra OpenAI Responses API.
 *
 * Diseño costo/latencia:
 *   1. Resolver primero respuestas obvias con matcher heurístico.
 *   2. Llamar al LLM sólo cuando el mensaje realmente necesita desambiguación.
 *   3. Si OpenAI falla, volver al matcher heurístico y nunca cortar el flujo.
 *
 * Modo dry-run / heurístico:
 *   - Si OPENAI_API_KEY no está seteada, o
 *   - Si CONFIRMATIONS_CLASSIFIER_DRY_RUN=true,
 * cae completamente al matcher por palabras clave.
 */

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.CONFIRMATIONS_CLASSIFIER_MODEL || "gpt-5-nano";
const TIMEOUT_MS = Math.max(1000, Number(process.env.CONFIRMATIONS_CLASSIFIER_TIMEOUT_MS || 5000));

export const INTENTS = Object.freeze({
  CONFIRM: "confirm",
  CANCEL: "cancel",
  RESCHEDULE: "reschedule",
  OTHER: "other",
  AMBIGUOUS: "ambiguous",
});

const INTENT_VALUES = Object.freeze(Object.values(INTENTS));

const SYSTEM_PROMPT = `Eres MelanIA, asistente de Clínyco que clasifica respuestas de pacientes a confirmaciones de cita médica enviadas por WhatsApp.

Tu única tarea es decidir la intención del paciente entre estas 5 categorías:
- "confirm": el paciente confirma que asistirá ("sí", "ok", "confirmo", "ahí estaré", "👍").
- "cancel": el paciente cancela ("no", "no puedo ir", "anula", "ya no").
- "reschedule": el paciente quiere cambiar fecha/hora ("reagendar", "¿puedo cambiarla?", "otro día").
- "other": el mensaje es relevante a la cita pero no encaja en las tres anteriores (pregunta de dirección, costo, etc.).
- "ambiguous": no hay forma razonable de decidir.

Prioriza el significado completo del mensaje. Si alguien dice "no puedo, ¿se puede pasar para la próxima semana?" es reschedule, no cancel.
No agregues explicaciones.`;

const RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: INTENT_VALUES,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["intent", "confidence"],
  additionalProperties: false,
});

/**
 * Clasifica un mensaje de paciente. Nunca lanza por errores de LLM:
 * en caso de fallo cae al matcher heurístico y reporta `model:"fallback"`.
 *
 * @param {string} message  texto crudo del paciente
 * @param {object} [opts]
 * @param {object} [opts.appointment] contexto opcional reservado para una
 *   iteración futura si necesitamos desambiguar respuestas tipo "el lunes mejor".
 *
 * @returns {Promise<{intent: string, confidence: number, model: string, raw?: string}>}
 */
export async function classifyInbound(message, _opts = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return { intent: INTENTS.AMBIGUOUS, confidence: 0, model: "empty" };
  }

  const fast = heuristic(text);

  // La mayoría de las respuestas de confirmación son inequívocas. No vale la pena
  // pagar ni agregar latencia por un LLM cuando el matcher ya tiene alta confianza.
  if (fast.intent !== INTENTS.AMBIGUOUS && fast.confidence >= 0.8) {
    return { ...fast, model: "heuristic" };
  }

  if (isDryRun()) {
    return { ...fast, model: "heuristic" };
  }

  try {
    return await classifyViaOpenAI(text);
  } catch (err) {
    console.error("[confirmations/classifier] openai failed, falling back:", err.message);
    return { ...fast, model: "fallback" };
  }
}

function isDryRun() {
  if (process.env.CONFIRMATIONS_CLASSIFIER_DRY_RUN === "true") return true;
  if (!process.env.OPENAI_API_KEY) return true;
  return false;
}

function reasoningEffortForModel(model) {
  const configured = String(process.env.CONFIRMATIONS_CLASSIFIER_REASONING || "").trim();
  if (configured) return configured;

  // gpt-5-nano usa la nomenclatura antigua donde el mínimo es `minimal`.
  if (/^gpt-5-nano(?:$|-)/i.test(model)) return "minimal";

  // Modelos nano/luna más nuevos aceptan `none`, ideal para clasificación.
  return "none";
}

async function classifyViaOpenAI(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        store: false,
        reasoning: {
          effort: reasoningEffortForModel(MODEL),
        },
        max_output_tokens: 256,
        input: [
          { role: "developer", content: SYSTEM_PROMPT },
          { role: "user", content: `Paciente: ${text}` },
        ],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "appointment_confirmation_intent",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`openai ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    const content = extractResponseText(json).trim();
    const parsed = parseJsonStrict(content);
    if (!parsed) {
      throw new Error(`unparseable model output: ${content.slice(0, 200)}`);
    }

    const intent = normalizeIntent(parsed.intent);
    const confidence = clamp01(Number(parsed.confidence));
    return { intent, confidence, model: MODEL, raw: content };
  } finally {
    clearTimeout(timer);
  }
}

function extractResponseText(json) {
  if (typeof json?.output_text === "string") return json.output_text;

  const chunks = [];
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("");
}

function parseJsonStrict(s) {
  try {
    return JSON.parse(s);
  } catch {
    // Structured Outputs debería evitar esto, pero mantenemos tolerancia defensiva.
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
  return INTENT_VALUES.includes(s) ? s : INTENTS.AMBIGUOUS;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Matcher determinista por keywords. Cubre las respuestas más comunes
 * (>80% de los casos según los logs históricos de CEROAI).
 *
 * Importante: RESCHEDULE se evalúa antes que CANCEL porque frases como
 * "no puedo, ¿puedo cambiarla?" deben interpretarse como reprogramación.
 */
function heuristic(text) {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/\b(reagendar|cambiar|reprogramar|otro dia|otra hora|otra fecha|posponer|pasar para|mover la hora|moverla)\b/.test(t)) {
    return { intent: INTENTS.RESCHEDULE, confidence: 0.9 };
  }
  if (/\b(si|sip|claro|ok|dale|confirmo|ahi estare|alli estare|asistire|voy|confirmada?)\b/.test(t) || /^(👍|✅|si\b)/.test(t)) {
    return { intent: INTENTS.CONFIRM, confidence: 0.85 };
  }
  if (/\b(no|cancel(ar|o|a)|anular|anula|ya no|no puedo|no podre|no asistire)\b/.test(t)) {
    return { intent: INTENTS.CANCEL, confidence: 0.85 };
  }
  return { intent: INTENTS.AMBIGUOUS, confidence: 0.4 };
}
