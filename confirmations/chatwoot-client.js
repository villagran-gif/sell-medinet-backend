/**
 * Cliente Chatwoot Cloud para el módulo confirmations.
 *
 * Envía HSM templates de WhatsApp vía la API de Chatwoot — Chatwoot
 * actúa de proxy hacia Meta, así no duplicamos auth con WhatsApp
 * Business API directo.
 *
 * Modo dry-run (CHATWOOT_DRY_RUN=true, default mientras los HSM no
 * estén aprobados en Meta Business Manager): no hace HTTP, devuelve
 * ids ficticios y loguea el payload que mandaría. Permite ejercitar
 * el flujo end-to-end sin entregar mensajes reales.
 *
 * Sin dependencias externas: usa fetch nativo (Node ≥18).
 *
 * Referencias API:
 *   - https://www.chatwoot.com/developers/api/#tag/Contacts
 *   - https://www.chatwoot.com/developers/api/#tag/Conversations
 *   - https://www.chatwoot.com/developers/api/#tag/Messages
 *   Para HSM/templates: campo `template_params` en el body del message.
 */

const DEFAULT_BASE_URL = "https://app.chatwoot.com";
const DEFAULT_ACCOUNT_ID = "162472";
// Defaults para HSM templates: Meta exige `name + category + language`
// junto con `processed_params`. Sin estos, Chatwoot no triggea el flujo
// de template y manda el `content` como mensaje plano → Meta lo rechaza
// por la ventana 24h. Overridables por env para futuras plantillas.
const DEFAULT_TEMPLATE_CATEGORY = process.env.CHATWOOT_HSM_CATEGORY || "UTILITY";
// es_CL = Spanish (Chile). Las plantillas Clínyco están registradas con
// ese language code en Meta, y Chatwoot las cachea con ese mismo code.
// Usar "es" genérico hace que Chatwoot no encuentre el match y mande
// `language.code: null` a Meta → error de schema.
const DEFAULT_TEMPLATE_LANGUAGE = process.env.CHATWOOT_HSM_LANGUAGE || "es_CL";

export function isDryRun() {
  // Default: true. Para activar tráfico real, setear CHATWOOT_DRY_RUN=false.
  return process.env.CHATWOOT_DRY_RUN !== "false";
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`confirmations/chatwoot-client: falta env ${name}`);
  return v;
}

function baseUrl() {
  return (process.env.CHATWOOT_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function accountId() {
  return process.env.CHATWOOT_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
}

function inboxId() {
  // Inbox de WhatsApp en Chatwoot Cloud. Requerido para enviar HSM.
  // Pendiente: el usuario debe setearlo cuando cree el inbox WA en Chatwoot.
  return requireEnv("CHATWOOT_INBOX_ID");
}

async function chatwootFetch(path, { method = "GET", body } = {}) {
  const token = requireEnv("CHATWOOT_API_TOKEN");
  const url = `${baseUrl()}/api/v1/accounts/${accountId()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      api_access_token: token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(
      `Chatwoot ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`
    );
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return json;
}

/**
 * Convierte un teléfono E.164 al `source_id` que Chatwoot exige para
 * inboxes WhatsApp: solo dígitos, regex `^\d{1,15}$`. Strippea el `+`
 * y cualquier separador. El `phone_number` del contacto sí lleva `+`,
 * pero `source_id` (que linkea el contacto al canal WhatsApp) es
 * digits-only — sin esta conversión, POST /conversations devuelve 422
 * "invalid source id for whatsapp inbox".
 */
function toChatwootSourceId(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/**
 * Busca un contacto por teléfono; si no existe lo crea.
 * Devuelve `{ id, sourceId }` donde sourceId es el identificador
 * que Chatwoot exige para inboxes WhatsApp (E.164 sin `+`).
 *
 * En modo dry-run devuelve un id sintético basado en el teléfono.
 */
export async function findOrCreateContact({ phone, name, email, identifier }) {
  if (!phone) throw new Error("findOrCreateContact: phone requerido");
  const sourceId = toChatwootSourceId(phone);

  if (isDryRun()) {
    console.log("[chatwoot-client/dry-run] findOrCreateContact", { phone, name, email });
    return {
      id: `dry_run_contact_${phone}`,
      sourceId,
      dryRun: true,
    };
  }

  // 1) Buscar por teléfono.
  const search = await chatwootFetch(
    `/contacts/search?q=${encodeURIComponent(phone)}`,
    { method: "GET" }
  );
  const found = (search?.payload || []).find(
    (c) => normalizePhone(c.phone_number) === normalizePhone(phone)
  );
  if (found) {
    return { id: found.id, sourceId };
  }

  // 2) Crear.
  const created = await chatwootFetch("/contacts", {
    method: "POST",
    body: {
      inbox_id: Number(inboxId()),
      name: name || phone,
      phone_number: phone,
      email: email || undefined,
      identifier: identifier || undefined,
    },
  });
  const contact = created?.payload?.contact || created?.contact || created;
  return { id: contact.id, sourceId };
}

/**
 * Crea una conversación nueva en el inbox WhatsApp y envía el HSM
 * template inicial en el mismo request. Es el camino correcto para
 * iniciar contacto fuera de la ventana de 24h.
 *
 * Returns: { conversationId, messageId }
 */
export async function startConversationWithTemplate({
  contactId,
  sourceId,
  templateName,
  templateParams,
  fallbackText,
}) {
  if (!templateName) throw new Error("startConversationWithTemplate: templateName requerido");

  if (isDryRun()) {
    console.log("[chatwoot-client/dry-run] startConversationWithTemplate", {
      contactId,
      sourceId,
      templateName,
      templateParams,
      fallbackText,
    });
    return {
      conversationId: `dry_run_conv_${contactId}`,
      messageId: `dry_run_msg_${templateName}_${Date.now()}`,
      dryRun: true,
    };
  }

  const resp = await chatwootFetch("/conversations", {
    method: "POST",
    body: {
      source_id: sourceId,
      inbox_id: Number(inboxId()),
      contact_id: contactId,
      message: {
        content: fallbackText || "",
        template_params: buildTemplateParams(templateName, templateParams),
      },
    },
  });
  return {
    conversationId: resp?.id,
    messageId: resp?.messages?.[0]?.id ?? null,
  };
}

/**
 * Envía un HSM template adicional en una conversación existente.
 * Usado para el recordatorio T-76h cuando la conversación del 1er
 * mensaje ya existe.
 */
export async function sendTemplateInConversation({
  conversationId,
  templateName,
  templateParams,
  fallbackText,
}) {
  if (!conversationId) throw new Error("sendTemplateInConversation: conversationId requerido");
  if (!templateName) throw new Error("sendTemplateInConversation: templateName requerido");

  if (isDryRun()) {
    console.log("[chatwoot-client/dry-run] sendTemplateInConversation", {
      conversationId,
      templateName,
      templateParams,
      fallbackText,
    });
    return {
      messageId: `dry_run_msg_${templateName}_${Date.now()}`,
      dryRun: true,
    };
  }

  const resp = await chatwootFetch(
    `/conversations/${conversationId}/messages`,
    {
      method: "POST",
      body: {
        content: fallbackText || "",
        message_type: "outgoing",
        template_params: buildTemplateParams(templateName, templateParams),
      },
    }
  );
  return { messageId: resp?.id ?? null };
}

/**
 * Envía un mensaje de TEXTO PLANO (no template) en una conversación
 * existente. Funciona solo si la ventana 24h está abierta (paciente
 * respondió hace < 24h). MelanIA lo usa para los acuses de recibo
 * después de procesar un intent (confirm/cancel/reschedule/ambiguous).
 *
 * Si la conversación está cerrada por inactividad, Meta lo rechaza —
 * habría que mandar un HSM. Pero para acuses post-respuesta, siempre
 * vamos a estar dentro de la ventana.
 */
export async function sendTextMessage({ conversationId, content }) {
  if (!conversationId) throw new Error("sendTextMessage: conversationId requerido");
  if (!content) throw new Error("sendTextMessage: content requerido");

  if (isDryRun()) {
    console.log("[chatwoot-client/dry-run] sendTextMessage", {
      conversationId,
      content: content.slice(0, 120),
    });
    return { messageId: `dry_run_msg_text_${Date.now()}`, dryRun: true };
  }

  const resp = await chatwootFetch(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: {
      content,
      message_type: "outgoing",
    },
  });
  return { messageId: resp?.id ?? null };
}

function normalizePhone(p) {
  return String(p || "").replace(/[^\d+]/g, "");
}

/**
 * Construye el `template_params` con la shape que Chatwoot requiere
 * para que efectivamente despache un HSM template (en vez de mandar
 * el `content` como mensaje plano).
 *
 *   {
 *     "name": "cly_confirm_appointment_v1",
 *     "category": "UTILITY",
 *     "language": "es_CL",
 *     "processed_params": { "body": { "1": "Juan", "2": "..." } }
 *   }
 *
 * `templateParams` viene de templates.js::buildConfirmParams() ya con
 * `processed_params` envuelto en `body`. Aquí inyectamos `name`,
 * `category` y `language` desde la config.
 */
function buildTemplateParams(templateName, templateParams) {
  return {
    name: templateName,
    category: DEFAULT_TEMPLATE_CATEGORY,
    language: DEFAULT_TEMPLATE_LANGUAGE,
    ...(templateParams || {}),
  };
}
