// Enriquecimiento multimodal para eventos Chatwoot antes de entregarlos a clinyco_AI.
//
// El raw_event persistido NO se modifica: este módulo devuelve una copia del payload.
// Sólo analiza imágenes de mensajes incoming. No registra URLs, imágenes ni contenido
// visual en logs. El resultado se agrega como texto estructurado para que el core de
// AntonIA pueda razonar con la imagen sin convertir el gateway en dueño del diálogo.

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_VISION_MODEL = "gpt-5-mini";
const DEFAULT_MAX_IMAGES = 3;
const DEFAULT_TIMEOUT_MS = 90_000;

function clampPositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function attachmentList(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.attachments)) return payload.attachments;

  const messages = payload.conversation?.messages;
  if (!Array.isArray(messages)) return [];
  const current = messages.find((m) => String(m?.id ?? "") === String(payload?.id ?? "")) || messages[0];
  return Array.isArray(current?.attachments) ? current.attachments : [];
}

export function getIncomingImageAttachments(payload) {
  if (payload?.message_type !== "incoming") return [];

  return attachmentList(payload).filter((attachment) => {
    const mime = String(attachment?.content_type || "").toLowerCase();
    const fileType = String(attachment?.file_type || "").toLowerCase();
    const url = attachment?.data_url || attachment?.thumb_url;
    return Boolean(url) && (mime.startsWith("image/") || fileType === "image");
  });
}

function buildVisionInstruction(originalText) {
  const textHint = String(originalText || "").trim();
  return [
    "Analiza esta imagen únicamente para apoyar una conversación de servicio al cliente de un centro médico.",
    "Describe lo que realmente sea visible y útil para responder al paciente: tipo de imagen/documento, texto legible relevante, procedimiento, profesional, sede, fecha, precio o pregunta implícita si aparecen.",
    "No inventes información que no se vea. No identifiques personas por rasgos físicos. No infieras atributos sensibles.",
    "Si parece una fotografía clínica o de una lesión, NO hagas diagnóstico: describe de forma general lo visible e indica que cualquier interpretación médica requiere evaluación profesional.",
    "Devuelve un resumen breve en español, máximo 120 palabras, pensado como contexto interno para otra IA.",
    textHint ? `Texto que acompañó la imagen: ${textHint}` : "La imagen llegó sin texto acompañante."
  ].join("\n");
}

async function analyzeImage({ imageUrl, originalText, apiKey, model, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildVisionInstruction(originalText) },
              { type: "image_url", image_url: { url: imageUrl, detail: "auto" } }
            ]
          }
        ],
        max_completion_tokens: 400
      }),
      signal: controller.signal
    });

    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }

    if (!response.ok) {
      throw new Error(`vision HTTP ${response.status}`);
    }

    const description = body?.choices?.[0]?.message?.content;
    if (!description || typeof description !== "string") {
      throw new Error("vision response without content");
    }

    return description.trim();
  } finally {
    clearTimeout(timer);
  }
}

function appendVisualContext(content, descriptions, totalImages) {
  const original = String(content || "").trim();
  const blocks = descriptions.map((description, index) => `Imagen ${index + 1}: ${description}`);
  const visualBlock = [
    "[CONTEXTO_VISUAL_INTERNO]",
    `El paciente adjuntó ${totalImages} imagen${totalImages === 1 ? "" : "es"}.`,
    ...blocks,
    "[/CONTEXTO_VISUAL_INTERNO]"
  ].join("\n");

  return original ? `${original}\n\n${visualBlock}` : visualBlock;
}

export async function enrichChatwootPayloadWithMediaContext(
  payload,
  {
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || DEFAULT_VISION_MODEL,
    fetchImpl = fetch,
    maxImages = clampPositiveInt(process.env.ANTONIA_MAX_VISION_IMAGES, DEFAULT_MAX_IMAGES, 5),
    timeoutMs = clampPositiveInt(process.env.ANTONIA_VISION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 180_000)
  } = {}
) {
  const images = getIncomingImageAttachments(payload);
  if (!images.length) return payload;

  // Si OpenAI no está configurado, no bloqueamos Chatwoot ni alteramos el texto.
  if (!apiKey) {
    return payload;
  }

  const selected = images.slice(0, maxImages);
  const descriptions = [];

  for (const attachment of selected) {
    try {
      const description = await analyzeImage({
        imageUrl: attachment.data_url || attachment.thumb_url,
        originalText: payload?.content,
        apiKey,
        model,
        fetchImpl,
        timeoutMs
      });
      if (description) descriptions.push(description);
    } catch (error) {
      // No exponer URL, payload ni contenido sensible en logs.
      console.warn("[antonia-media] image analysis failed:", error.message);
    }
  }

  if (!descriptions.length) return payload;

  return {
    ...payload,
    content: appendVisualContext(payload?.content, descriptions, images.length),
    additional_attributes: {
      ...(payload?.additional_attributes || {}),
      antonia_media_context: {
        image_count: images.length,
        analyzed_count: descriptions.length,
        model
      }
    }
  };
}
