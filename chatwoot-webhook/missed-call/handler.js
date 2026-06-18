// Pipeline de follow-up para llamadas perdidas.
//
// Cuando una llamada del canal Voice queda como "missed" (no agent picked up),
// este handler:
//   1. Lee la conversación de voz desde Chatwoot API.
//   2. Identifica que es missed call + extrae el número del cliente.
//   3. Busca/crea el contacto en Chatwoot.
//   4. Crea conversación NUEVA en el inbox de WhatsApp + envía el template.
//   5. Aplica label `missed-call-bot` para filtrado.
//   6. Auto-resuelve la conversación para que NO aparezca en la cola de
//      "Sin asignar" → cero ruido para los agentes.
//   7. Actualiza el contacto con last_missed_call_at.
//
// Si el cliente responde (Quick Reply o texto libre), Chatwoot reabre la
// conversación automáticamente y entra al flujo normal con las reglas de
// asignación existentes.
//
// Idempotente: la tabla chatwoot.missed_call_followups tiene UNIQUE sobre
// conversation_id, así que aunque Chatwoot dispare el webhook 2 veces, el
// cliente recibe el template UNA sola vez.

import { getPool } from "../db.js";
import {
  getConversation,
  searchContactByPhone,
  createContact,
  createConversation,
  toggleConversationStatus,
  addConversationLabels,
  updateContactAttributes,
} from "../lib/chatwoot-api.js";

const DISPATCH_TTL_MS = 60_000;
const recentlyDispatched = new Map();

function alreadyDispatched(id) {
  const ts = recentlyDispatched.get(id);
  if (!ts) return false;
  if (Date.now() - ts > DISPATCH_TTL_MS) {
    recentlyDispatched.delete(id);
    return false;
  }
  return true;
}

function markDispatched(id) {
  recentlyDispatched.set(id, Date.now());
  if (recentlyDispatched.size > 1000) {
    const now = Date.now();
    for (const [k, v] of recentlyDispatched) {
      if (now - v > DISPATCH_TTL_MS) recentlyDispatched.delete(k);
    }
  }
}

function isInterestingEvent(payload) {
  const ev = payload?.event;
  return (
    ev === "conversation_created" ||
    ev === "conversation_updated" ||
    ev === "conversation_status_changed"
  );
}

function extractConversationId(payload) {
  const conv = payload?.conversation || payload || {};
  return conv.display_id || conv.id || null;
}

function isVoiceConv(conv) {
  const ct =
    conv?.meta?.channel ||
    conv?.inbox?.channel_type ||
    conv?.channel ||
    "";
  return String(ct).toLowerCase().includes("voice");
}

function isMissedCall(conv) {
  // Chatwoot Voice marca missed calls de varias formas según versión.
  // Probamos los shapes conocidos.
  const aa = conv?.additional_attributes || {};
  const candidates = [
    aa.call_status,
    aa.callStatus,
    aa.status,
    aa.disposition,
    conv?.call_status,
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());
  for (const s of candidates) {
    if (s.includes("missed") || s === "no-answer") return true;
  }
  // Heurística adicional: si hay messages "missed_call" type.
  const msgs = conv?.messages || [];
  for (const m of msgs) {
    const ct = (m?.content_type || "").toLowerCase();
    const txt = (m?.content || "").toLowerCase();
    if (ct.includes("missed") || txt.includes("no agent picked up") || txt.includes("missed call")) {
      return true;
    }
  }
  return false;
}

function extractCustomerPhone(conv) {
  return (
    conv?.meta?.sender?.phone_number ||
    conv?.contact?.phone_number ||
    conv?.contact_inbox?.source_id ||
    null
  );
}

function extractCustomerName(conv) {
  return (
    conv?.meta?.sender?.name ||
    conv?.contact?.name ||
    ""
  );
}

function firstName(fullName) {
  return (fullName || "").trim().split(/\s+/)[0] || "";
}

// Entry point disparado por routes/events.js
export async function maybeFollowupMissedCall(payload) {
  if (process.env.CHATWOOT_MISSED_CALL_ENABLED !== "true") return;
  if (!isInterestingEvent(payload)) return;

  const conversationId = extractConversationId(payload);
  if (!conversationId) return;

  if (alreadyDispatched(conversationId)) return;
  markDispatched(conversationId);

  try {
    await processConversation(conversationId);
  } catch (err) {
    console.error(`[missed-call] conv ${conversationId} failed:`, err.message);
  }
}

async function processConversation(conversationId) {
  const pool = getPool();

  // Skip si ya está sent o pending procesándose
  const existing = await pool.query(
    `SELECT status FROM chatwoot.missed_call_followups
      WHERE conversation_id = $1`,
    [conversationId]
  );
  if (existing.rowCount > 0) {
    const s = existing.rows[0].status;
    if (s === "sent" || s === "processing" || s === "skipped") return;
  }

  // Pedimos la conversación completa
  const conv = await getConversation(conversationId);
  if (!isVoiceConv(conv)) return;
  if (!isMissedCall(conv)) return;

  const customerPhone = extractCustomerPhone(conv);
  if (!customerPhone) {
    await pool.query(
      `INSERT INTO chatwoot.missed_call_followups
        (conversation_id, status, error)
       VALUES ($1, 'skipped', 'no customer phone found')
       ON CONFLICT (conversation_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [conversationId]
    );
    return;
  }

  const customerName = extractCustomerName(conv);
  const aa = conv?.additional_attributes || {};
  const callSid = aa.call_sid || aa.callSid || null;

  // Lock optimista
  await pool.query(
    `INSERT INTO chatwoot.missed_call_followups
      (conversation_id, account_id, call_sid, customer_phone, customer_name, status, attempts)
     VALUES ($1, $2, $3, $4, $5, 'processing', 1)
     ON CONFLICT (conversation_id) DO UPDATE
       SET status = 'processing',
           attempts = chatwoot.missed_call_followups.attempts + 1,
           call_sid = COALESCE(EXCLUDED.call_sid, chatwoot.missed_call_followups.call_sid),
           updated_at = now()`,
    [conversationId, conv?.account_id || null, callSid, customerPhone, customerName || null]
  );

  const inboxId = Number(process.env.CHATWOOT_WHATSAPP_INBOX_ID);
  if (!inboxId) {
    await pool.query(
      `UPDATE chatwoot.missed_call_followups
         SET status = 'failed', error = 'missing CHATWOOT_WHATSAPP_INBOX_ID env', updated_at = now()
       WHERE conversation_id = $1`,
      [conversationId]
    );
    throw new Error("missing CHATWOOT_WHATSAPP_INBOX_ID");
  }

  const templateName = process.env.CHATWOOT_MISSED_CALL_TEMPLATE || "missed_call_followup";
  const language = process.env.CHATWOOT_MISSED_CALL_LANGUAGE || "es";
  const labelName = process.env.CHATWOOT_MISSED_CALL_LABEL || "missed-call-bot";

  try {
    // 1. Buscar contacto existente por número
    let contactId = null;
    try {
      const search = await searchContactByPhone(customerPhone);
      const payload = search?.payload || [];
      const match = payload.find((c) => {
        const ph = (c?.phone_number || "").replace(/\D/g, "");
        return ph && ph === customerPhone.replace(/\D/g, "");
      });
      contactId = match?.id || null;
    } catch {
      /* siguiente intento */
    }

    // 2. Si no existe, crearlo
    if (!contactId) {
      const created = await createContact({
        name: customerName || customerPhone,
        phone_number: customerPhone,
        inbox_id: inboxId,
      });
      contactId = created?.payload?.contact?.id || created?.id || null;
      if (!contactId) throw new Error("failed to create contact");
    }

    // 3. Crear conversación en inbox WhatsApp + enviar template
    const fname = firstName(customerName);
    const conv2 = await createConversation({
      source_id: customerPhone,
      inbox_id: inboxId,
      contact_id: contactId,
      message: {
        content:
          `📞 Hola ${fname || ""}, recibimos tu llamada a Clinyco y no alcanzamos a contestar.\n\n¿Podemos ayudarte por acá?`.trim(),
        template_params: {
          name: templateName,
          category: "UTILITY",
          language,
          processed_params: { "1": fname || "" },
        },
      },
    });
    const followupConvId = conv2?.id;
    if (!followupConvId) throw new Error("failed to create followup conversation");

    // 4. Label (best-effort, no crítico)
    try {
      await addConversationLabels(followupConvId, [labelName]);
    } catch (e) {
      console.warn(`[missed-call] label failed for ${followupConvId}:`, e.message);
    }

    // 5. Auto-resolver para que NO aparezca en la cola de agentes
    try {
      await toggleConversationStatus(followupConvId, "resolved");
    } catch (e) {
      console.warn(`[missed-call] resolve failed for ${followupConvId}:`, e.message);
    }

    // 6. Custom attribute en el contacto (best-effort)
    try {
      await updateContactAttributes(contactId, {
        last_missed_call_at: new Date().toISOString(),
      });
    } catch (e) {
      /* no crítico */
    }

    await pool.query(
      `UPDATE chatwoot.missed_call_followups
         SET status = 'sent',
             contact_id = $2,
             followup_conversation_id = $3,
             template_name = $4,
             error = NULL,
             updated_at = now()
       WHERE conversation_id = $1`,
      [conversationId, contactId, followupConvId, templateName]
    );

    console.log(
      `[missed-call] sent template '${templateName}' to ${customerPhone} (voice_conv=${conversationId} → wa_conv=${followupConvId})`
    );
  } catch (err) {
    await pool.query(
      `UPDATE chatwoot.missed_call_followups
         SET status = 'failed', error = $2, updated_at = now()
       WHERE conversation_id = $1`,
      [conversationId, String(err.message || err).slice(0, 500)]
    );
    throw err;
  }
}

// Disparo manual para tests (sin esperar webhook).
export async function followupNow(conversationId) {
  await processConversation(Number(conversationId));
  return { conversation_id: conversationId };
}

// Entry point alternativo desde el polling de Twilio:
// el polling ya filtró por duración (heurística de missed), entonces acá NO
// volvemos a chequear isMissedCall — confiamos en el caller.
// Solo necesita el conversation_id de Chatwoot.
export async function followupFromPolling({ conversationId, callSid, customerPhone, customerName }) {
  if (process.env.CHATWOOT_MISSED_CALL_ENABLED !== "true") return;
  if (!conversationId) return;

  const pool = getPool();

  // Skip si ya procesamos (idempotente)
  const existing = await pool.query(
    `SELECT status FROM chatwoot.missed_call_followups WHERE conversation_id = $1`,
    [conversationId]
  );
  if (existing.rowCount > 0) {
    const s = existing.rows[0].status;
    if (s === "sent" || s === "processing" || s === "skipped") return;
  }

  // Marcar como processing
  await pool.query(
    `INSERT INTO chatwoot.missed_call_followups
      (conversation_id, call_sid, customer_phone, customer_name, status, attempts)
     VALUES ($1, $2, $3, $4, 'processing', 1)
     ON CONFLICT (conversation_id) DO UPDATE
       SET status = 'processing',
           attempts = chatwoot.missed_call_followups.attempts + 1,
           call_sid = COALESCE(EXCLUDED.call_sid, chatwoot.missed_call_followups.call_sid),
           updated_at = now()`,
    [conversationId, callSid || null, customerPhone, customerName || null]
  );

  // Reutilizamos el flujo de envío del template
  await sendFollowupTemplate({ conversationId, customerPhone, customerName });
}

async function sendFollowupTemplate({ conversationId, customerPhone, customerName }) {
  const pool = getPool();
  const inboxId = Number(process.env.CHATWOOT_WHATSAPP_INBOX_ID);
  if (!inboxId) {
    await pool.query(
      `UPDATE chatwoot.missed_call_followups
         SET status = 'failed', error = 'missing CHATWOOT_WHATSAPP_INBOX_ID env', updated_at = now()
       WHERE conversation_id = $1`,
      [conversationId]
    );
    throw new Error("missing CHATWOOT_WHATSAPP_INBOX_ID");
  }

  const templateName = process.env.CHATWOOT_MISSED_CALL_TEMPLATE || "missed_call_followup";
  const language = process.env.CHATWOOT_MISSED_CALL_LANGUAGE || "es";
  const labelName = process.env.CHATWOOT_MISSED_CALL_LABEL || "missed-call-bot";

  try {
    // 1. Contacto
    let contactId = null;
    try {
      const search = await searchContactByPhone(customerPhone);
      const list = search?.payload || [];
      const target = String(customerPhone).replace(/\D/g, "");
      const match = list.find((c) => String(c?.phone_number || "").replace(/\D/g, "") === target);
      contactId = match?.id || null;
    } catch {}
    if (!contactId) {
      const created = await createContact({
        name: customerName || customerPhone,
        phone_number: customerPhone,
        inbox_id: inboxId,
      });
      contactId = created?.payload?.contact?.id || created?.id || null;
      if (!contactId) throw new Error("failed to create contact");
    }

    // 2. Conversación + template
    const fname = firstName(customerName);
    const conv2 = await createConversation({
      source_id: customerPhone,
      inbox_id: inboxId,
      contact_id: contactId,
      message: {
        content:
          `📞 Hola ${fname || ""}, recibimos tu llamada a Clinyco y no alcanzamos a contestar.\n\n¿Podemos ayudarte por acá?`.trim(),
        template_params: {
          name: templateName,
          category: "UTILITY",
          language,
          processed_params: { "1": fname || "" },
        },
      },
    });
    const followupConvId = conv2?.id;
    if (!followupConvId) throw new Error("failed to create followup conversation");

    try { await addConversationLabels(followupConvId, [labelName]); } catch {}
    try { await toggleConversationStatus(followupConvId, "resolved"); } catch {}
    try { await updateContactAttributes(contactId, { last_missed_call_at: new Date().toISOString() }); } catch {}

    await pool.query(
      `UPDATE chatwoot.missed_call_followups
         SET status = 'sent', contact_id = $2, followup_conversation_id = $3,
             template_name = $4, error = NULL, updated_at = now()
       WHERE conversation_id = $1`,
      [conversationId, contactId, followupConvId, templateName]
    );

    console.log(`[missed-call] sent '${templateName}' to ${customerPhone} (voice=${conversationId} → wa=${followupConvId})`);
  } catch (err) {
    await pool.query(
      `UPDATE chatwoot.missed_call_followups
         SET status = 'failed', error = $2, updated_at = now()
       WHERE conversation_id = $1`,
      [conversationId, String(err.message || err).slice(0, 500)]
    );
    throw err;
  }
}
