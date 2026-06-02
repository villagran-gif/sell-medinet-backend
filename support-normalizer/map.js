// support-normalizer/map.js
//
// Transforma un payload de Chatwoot `message_created` (Cloud, cuenta 162472)
// a la forma canónica que el writer usa para espejar en `support.*`.
// Pure: sin DB ni env. Testeable en aislamiento.
//
// Shape de referencia (de confirmations/inbound-processor.js + Chatwoot docs):
//   {
//     event: "message_created",
//     message_type: "incoming" | "outgoing" | "activity" | "template",
//     content: "Sí, ahí estaré",
//     private: false,
//     created_at: "2026-06-02T22:00:00Z",
//     sender: { id, name, phone_number, email },
//     conversation: { id, status, inbox_id, meta: { sender } },
//     inbox: { id, name }
//   }

// Solo reflejamos mensajes de personas (paciente o agente). Los de sistema
// (activity) y plantillas crudas no son comentarios de soporte.
const REFLECTED_TYPES = new Set(["incoming", "outgoing"]);

export function mapMessageCreated(payload) {
  if (!payload || payload.event !== "message_created") return null;

  const messageType = payload.message_type || null;
  if (messageType && !REFLECTED_TYPES.has(messageType)) return null;

  const content = String(payload.content ?? "").trim();
  // Mensajes sin texto (solo adjuntos) se omiten por ahora — TODO adjuntos.
  if (!content) return null;

  const conv = payload.conversation || {};
  const conversationId = conv.id;
  if (conversationId === undefined || conversationId === null) return null;

  const sender = payload.sender || conv.meta?.sender || {};
  const contact = {
    chatwootId: numOrNull(sender.id),
    name: strOrNull(sender.name),
    phone: strOrNull(sender.phone_number),
    email: strOrNull(sender.email),
  };

  const inboxId = numOrNull(payload.inbox?.id ?? conv.inbox_id ?? conv.meta?.inbox_id);

  return {
    conversation: {
      chatwootId: Number(conversationId),
      status: strOrNull(conv.status),
      inboxId,
      subject: buildSubject(conversationId, contact),
    },
    contact,
    comment: {
      body: content,
      // Privadas de Chatwoot (notas internas) → no públicas.
      isPublic: payload.private === true ? false : true,
      // incoming = paciente; outgoing = agente/bot.
      isIncoming: messageType !== "outgoing",
      createdAt: strOrNull(payload.created_at),
    },
  };
}

// Mapea el status de Chatwoot al vocabulario tipo Zendesk de support.tickets.
export function mapStatus(chatwootStatus) {
  switch (String(chatwootStatus || "").toLowerCase()) {
    case "resolved":
      return "solved";
    case "pending":
      return "pending";
    case "snoozed":
      return "hold";
    case "open":
      return "open";
    default:
      return "open";
  }
}

function buildSubject(conversationId, contact) {
  const who = contact.name || contact.phone || "Contacto";
  return `Chatwoot #${conversationId} — ${who}`;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}
