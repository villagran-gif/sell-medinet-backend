/**
 * Scheduler outbound: 1er mensaje (al agendar) + 3 recordatorios
 * (T-72h, T-24h, T-4h), cada uno con dirección y link de mapa.
 *
 * No usa setInterval interno; expone `tick({ limit })` que ejecuta
 * una pasada. Un cron externo (Render Cron, GitHub Actions, etc.)
 * llama POST /confirmations/tick cada N minutos.
 *
 * Idempotencia:
 *   - El UNIQUE parcial (appointment_id, template_name) WHERE error IS NULL
 *     en outbound_messages bloquea reenvíos del mismo template. Cada
 *     recordatorio loguea con template_name `<REMINDER>:<kind>` para que
 *     las 3 ventanas no colisionen entre sí.
 *   - Las transiciones markFirstMessageSent / markReminderKindSent usan
 *     COALESCE para no pisar timestamps existentes.
 *   - Cada ventana filtra por su propia columna reminder_<kind>_sent_at.
 *
 * Anti-colisión 1er mensaje vs recordatorio: una cita solo entra a
 * ventana de recordatorio si su first_msg_sent_at tiene al menos
 * REMINDER_MIN_GAP_HOURS de antigüedad, evitando confirmación +
 * recordatorio en el mismo tick para citas creadas muy cerca de su fecha.
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
  markReminderKindSent,
  logOutbound,
} from "./lifecycle.js";

const FIRST_MSG_DEFAULT_LIMIT = 20;
const REMINDER_DEFAULT_LIMIT = 50;

// Gap mínimo entre el 1er mensaje y cualquier recordatorio, para que NO
// salgan en el mismo tick cuando una cita se crea muy cerca de su fecha.
// Overridable por env (default 2h).
const REMINDER_MIN_GAP_HOURS = (() => {
  const n = Number(process.env.CONFIRMATIONS_REMINDER_MIN_GAP_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 2;
})();

// Definición de las 3 ventanas de recordatorio. Cada una cubre un rango
// de horas-hasta-la-cita disjunto (no se solapan), y se trackea con su
// propia columna para idempotencia independiente.
//   72h → cita entre 24h y 72h en el futuro
//   24h → cita entre 4h y 24h
//   4h  → cita entre 0h y 4h
const REMINDER_WINDOWS = [
  { kind: "72h", column: "reminder_72h_sent_at", loHours: 24, hiHours: 72, timeframe: "es en los próximos días" },
  { kind: "24h", column: "reminder_24h_sent_at", loHours: 4,  hiHours: 24, timeframe: "es mañana" },
  { kind: "4h",  column: "reminder_4h_sent_at",  loHours: 0,  hiHours: 4,  timeframe: "es hoy, en unas horas" },
];

/**
 * Ejecuta un tick completo: 1er mensajes pendientes + los 3 recordatorios.
 */
export async function tick({ firstMsgLimit, reminderLimit } = {}) {
  const first = await sendPendingFirstMessages({
    limit: firstMsgLimit ?? FIRST_MSG_DEFAULT_LIMIT,
  });

  const reminders = {};
  for (const win of REMINDER_WINDOWS) {
    reminders[win.kind] = await sendRemindersForWindow(win, {
      limit: reminderLimit ?? REMINDER_DEFAULT_LIMIT,
    });
  }

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
// Recordatorios (T-72h / T-24h / T-4h)
// ----------------------------------------------------------------
//
// Genérico: una sola función cubre las 3 ventanas. `win` trae el rango
// de horas-hasta-la-cita, la columna de tracking y el timeframe textual.
//
// Anti-colisión: exigimos que el 1er mensaje se haya mandado hace al
// menos REMINDER_MIN_GAP_HOURS, así una cita recién creada muy cerca de
// su fecha NO dispara confirmación + recordatorio en el mismo tick.
async function sendRemindersForWindow(win, { limit }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT *
      FROM confirmations.appointments
     WHERE ${win.column} IS NULL
       AND state IN ('first_msg_sent', 'confirmed')
       AND first_msg_sent_at IS NOT NULL
       AND first_msg_sent_at < now() - ($4 || ' hours')::interval
       AND appointment_at >= (now() + ($2 || ' hours')::interval)
       AND appointment_at <  (now() + ($3 || ' hours')::interval)
     ORDER BY appointment_at ASC
     LIMIT $1
    `,
    [
      limit,
      String(win.loHours),
      String(win.hiHours),
      String(REMINDER_MIN_GAP_HOURS),
    ]
  );

  const summary = { scanned: rows.length, sent: 0, failed: 0 };
  for (const apt of rows) {
    try {
      await sendReminderFor(apt, win);
      summary.sent++;
    } catch (err) {
      summary.failed++;
      console.error(
        `[confirmations/scheduler] reminder ${win.kind} appointment ${apt.id} failed:`,
        err.message
      );
      await logOutbound({
        appointmentId: apt.id,
        templateName: `${TEMPLATES.REMINDER}:${win.kind}`,
        templateParams: null,
        chatwootMessageId: null,
        dryRun: chatwootDryRun(),
        error: err.message.slice(0, 500),
      });
    }
  }
  return summary;
}

async function sendReminderFor(apt, win) {
  const params = buildReminderParams(apt, win.timeframe);
  const fallback = buildFallbackText(apt, "remind", win.timeframe);

  let messageId = null;
  if (apt.chatwoot_conversation_id) {
    // La conversación ya existe del 1er mensaje — reusarla.
    const r = await sendTemplateInConversation({
      conversationId: apt.chatwoot_conversation_id,
      templateName: TEMPLATES.REMINDER,
      templateParams: params,
      fallbackText: fallback,
    });
    messageId = r.messageId;
  } else {
    // Edge case: no hay conversación previa. Abrir una nueva.
    const contact = await findOrCreateContact({
      phone: apt.patient_phone,
      name: apt.patient_name,
      email: apt.patient_email,
      identifier: apt.patient_run || undefined,
    });
    const r = await startConversationWithTemplate({
      contactId: contact.id,
      sourceId: contact.sourceId,
      templateName: TEMPLATES.REMINDER,
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

  // template_name distinto por ventana → el UNIQUE parcial de outbound
  // permite registrar los 3 recordatorios sin colisionar entre sí.
  await logOutbound({
    appointmentId: apt.id,
    templateName: `${TEMPLATES.REMINDER}:${win.kind}`,
    templateParams: params,
    chatwootMessageId: numericOrNull(messageId),
    dryRun: chatwootDryRun(),
  });

  await markReminderKindSent({ appointmentId: apt.id, column: win.column });
}

function numericOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
