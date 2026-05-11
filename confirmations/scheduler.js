/**
 * Scheduler outbound: 1er mensaje y recordatorio T-76h.
 *
 * No usa setInterval interno; expone `tick({ limit })` que ejecuta
 * una pasada. Un cron externo (Render Cron, GitHub Actions, etc.)
 * llama POST /confirmations/tick cada N minutos.
 *
 * Idempotencia:
 *   - El UNIQUE parcial (appointment_id, template_name) WHERE error IS NULL
 *     en outbound_messages bloquea reenvíos del mismo template.
 *   - Las transiciones markFirstMessageSent / markReminderSent usan
 *     COALESCE para no pisar timestamps existentes.
 *   - El WHERE de selección filtra por state + reminder_sent_at IS NULL.
 *
 * Ventana T-76h: usamos [appointment_at - 78h, appointment_at - 74h]
 * para tolerar cron cada hora o dos sin perder citas. La idempotencia
 * de logOutbound evita doble envío si la ventana se solapa.
 */

import { getPool } from "./db.js";
import {
  findOrCreateContact,
  startConversationWithTemplate,
  sendTemplateInConversation,
  isDryRun as chatwootDryRun,
} from "./chatwoot-client.js";
import {
  TEMPLATES,
  buildConfirmParams,
  buildReminderParams,
  buildFallbackText,
} from "./templates.js";
import {
  markFirstMessageSent,
  markReminderSent,
  logOutbound,
} from "./lifecycle.js";

const FIRST_MSG_DEFAULT_LIMIT = 20;
const REMINDER_DEFAULT_LIMIT = 50;

/**
 * Ejecuta un tick completo: primero los 1er mensajes pendientes,
 * después los recordatorios T-76h. Devuelve summary agregado.
 */
export async function tick({ firstMsgLimit, reminderLimit } = {}) {
  const first = await sendPendingFirstMessages({
    limit: firstMsgLimit ?? FIRST_MSG_DEFAULT_LIMIT,
  });
  const reminders = await sendPendingReminders({
    limit: reminderLimit ?? REMINDER_DEFAULT_LIMIT,
  });
  return {
    dry_run: chatwootDryRun(),
    first_messages: first,
    reminders,
  };
}

// ----------------------------------------------------------------
// 1er mensaje (apenas se detecta la cita)
// ----------------------------------------------------------------
async function sendPendingFirstMessages({ limit }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT *
      FROM confirmations.appointments
     WHERE state = 'scheduled'
       AND first_msg_sent_at IS NULL
       AND appointment_at > now()        -- no spamear citas ya pasadas
     ORDER BY created_at ASC
     LIMIT $1
    `,
    [limit]
  );

  const summary = { scanned: rows.length, sent: 0, failed: 0 };
  for (const apt of rows) {
    try {
      await sendFirstMessageFor(apt);
      summary.sent++;
    } catch (err) {
      summary.failed++;
      console.error(
        `[confirmations/scheduler] first_msg appointment ${apt.id} failed:`,
        err.message
      );
      await logOutbound({
        appointmentId: apt.id,
        templateName: TEMPLATES.CONFIRM_APPOINTMENT,
        templateParams: null,
        chatwootMessageId: null,
        dryRun: chatwootDryRun(),
        error: err.message.slice(0, 500),
      });
    }
  }
  return summary;
}

async function sendFirstMessageFor(apt) {
  const params = buildConfirmParams(apt);
  const fallback = buildFallbackText(apt, "confirm");

  const contact = await findOrCreateContact({
    phone: apt.patient_phone,
    name: apt.patient_name,
    email: apt.patient_email,
    identifier: apt.patient_run || undefined,
  });

  const { conversationId, messageId } = await startConversationWithTemplate({
    contactId: contact.id,
    sourceId: contact.sourceId,
    templateName: TEMPLATES.CONFIRM_APPOINTMENT,
    templateParams: params,
    fallbackText: fallback,
  });

  await logOutbound({
    appointmentId: apt.id,
    templateName: TEMPLATES.CONFIRM_APPOINTMENT,
    templateParams: params,
    chatwootMessageId: numericOrNull(messageId),
    dryRun: chatwootDryRun(),
  });

  await markFirstMessageSent({
    appointmentId: apt.id,
    chatwootContactId: numericOrNull(contact.id),
    chatwootConversationId: numericOrNull(conversationId),
  });
}

// ----------------------------------------------------------------
// Recordatorio T-76h
// ----------------------------------------------------------------
async function sendPendingReminders({ limit }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT *
      FROM confirmations.appointments
     WHERE reminder_sent_at IS NULL
       AND state IN ('first_msg_sent', 'confirmed')
       AND appointment_at BETWEEN (now() + interval '74 hours')
                              AND (now() + interval '78 hours')
     ORDER BY appointment_at ASC
     LIMIT $1
    `,
    [limit]
  );

  const summary = { scanned: rows.length, sent: 0, failed: 0 };
  for (const apt of rows) {
    try {
      await sendReminderFor(apt);
      summary.sent++;
    } catch (err) {
      summary.failed++;
      console.error(
        `[confirmations/scheduler] reminder appointment ${apt.id} failed:`,
        err.message
      );
      await logOutbound({
        appointmentId: apt.id,
        templateName: TEMPLATES.REMIND_76H,
        templateParams: null,
        chatwootMessageId: null,
        dryRun: chatwootDryRun(),
        error: err.message.slice(0, 500),
      });
    }
  }
  return summary;
}

async function sendReminderFor(apt) {
  const params = buildReminderParams(apt);
  const fallback = buildFallbackText(apt, "remind");

  let messageId = null;
  if (apt.chatwoot_conversation_id) {
    // La conversación ya existe del 1er mensaje — reusarla.
    const r = await sendTemplateInConversation({
      conversationId: apt.chatwoot_conversation_id,
      templateName: TEMPLATES.REMIND_76H,
      templateParams: params,
      fallbackText: fallback,
    });
    messageId = r.messageId;
  } else {
    // Edge case: nunca se mandó el 1er mensaje pero la cita llegó
    // tan cerca que ya cae en ventana de recordatorio. Mandar el
    // recordatorio como si fuera primer contacto.
    const contact = await findOrCreateContact({
      phone: apt.patient_phone,
      name: apt.patient_name,
      email: apt.patient_email,
      identifier: apt.patient_run || undefined,
    });
    const r = await startConversationWithTemplate({
      contactId: contact.id,
      sourceId: contact.sourceId,
      templateName: TEMPLATES.REMIND_76H,
      templateParams: params,
      fallbackText: fallback,
    });
    messageId = r.messageId;
    await markFirstMessageSent({
      appointmentId: apt.id,
      chatwootContactId: numericOrNull(contact.id),
      chatwootConversationId: numericOrNull(r.conversationId),
    });
  }

  await logOutbound({
    appointmentId: apt.id,
    templateName: TEMPLATES.REMIND_76H,
    templateParams: params,
    chatwootMessageId: numericOrNull(messageId),
    dryRun: chatwootDryRun(),
  });

  await markReminderSent({ appointmentId: apt.id });
}

function numericOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
