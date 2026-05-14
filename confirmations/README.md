# confirmations — Sistema MelanIA de confirmaciones de citas

Reemplaza CEROAI. Recibe citas Medinet empujadas desde clinyco_AI
(VPS chileno), envía la confirmación inicial vía WhatsApp / Chatwoot
Cloud, recibe la respuesta del paciente, la clasifica con Claude Haiku
4.5 y deriva el flujo según la intención. T-76h antes manda recordatorio.

## Decisiones arquitectónicas

| Pieza | Decisión |
|---|---|
| Bot | **MelanIA** |
| Transporte WhatsApp | **Chatwoot Cloud** (`app.chatwoot.com`, accountId `162472`) |
| Clasificador | **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) |
| Origen de citas | Push desde **clinyco_AI** (VPS chileno con acceso geo a Medinet) → `POST /confirmations/intake` |
| Trigger 1er msg | apenas la cita llega al intake (state `scheduled` → `first_msg_sent`) |
| Recordatorio | T-76h antes de `appointment_at`, ventana tolerante 74–78h |
| Reschedule | handoff HTTP a `clinyco_AI/melania/start-from-confirmation` |
| Sucursales | **todas** |
| Persistencia | schema `confirmations.*` en Postgres compartido |

## Montaje

Opt-in. Sin nuevas dependencias (usa `express`, `pg` y `fetch` nativo).

```js
// server.js (ya cableado)
if (process.env.CONFIRMATIONS_ENABLED === "true") {
  app.use("/confirmations", createConfirmationsRouter({
    autoMigrate: process.env.CONFIRMATIONS_AUTO_MIGRATE !== "false",
  }));
}
```

## Endpoints

| Método | Path | Auth | Uso |
|---|---|---|---|
| GET  | `/confirmations/health` | — | Liveness + conteo de `appointments`. |
| POST | `/confirmations/intake` | Bearer | clinyco_AI empuja una cita normalizada. Idempotente por `external_id`. |
| POST | `/confirmations/process-inbound?limit=50` | Bearer | Procesa cola `chatwoot.raw_events` pendiente (clasificador → transición). |
| POST | `/confirmations/tick?firstLimit=20&reminderLimit=50` | Bearer | 1er mensajes + recordatorios T-76h. |

Cron sugerido (Render Cron / GitHub Actions / cron VPS):

```
*/2  * * * *   curl -fsS -X POST -H "Authorization: Bearer $T" https://sell-medinet-backend.onrender.com/confirmations/process-inbound
*/10 * * * *   curl -fsS -X POST -H "Authorization: Bearer $T" https://sell-medinet-backend.onrender.com/confirmations/tick
```

## State machine (`confirmations.appointments.state`)

```
                       ┌─────────────┐
   intake →            │  scheduled  │
                       └──────┬──────┘
                              │ scheduler.sendPendingFirstMessages
                              ▼
                       ┌─────────────────┐
                       │ first_msg_sent  │
                       └────┬───────┬────┘
              inbound:      │       │      scheduler.sendPendingReminders
            confirm/cancel/ │       │              (T-76h)
            reschedule      │       ▼
                            │   ┌──────────────┐
                            │   │ reminder_sent│
                            │   └──────┬───────┘
                            │          │ inbound
                            ▼          ▼
                 ┌──────────────┬──────────────┬──────────────────────┐
                 │  confirmed   │  cancelled   │ reschedule_requested │
                 └──────────────┴──────────────┴──────────────────────┘
                                                          │
                                                          ▼
                                          handoff HTTP a clinyco_AI
                                          (/melania/start-from-confirmation)
```

## Variables de entorno

| Var | Requerida | Default | Para qué |
|---|---|---|---|
| `CONFIRMATIONS_ENABLED` | sí | `false` | Activa el módulo. |
| `CONFIRMATIONS_AUTO_MIGRATE` | no | `true` | Corre DDL al arranque. |
| `CONFIRMATIONS_DATABASE_URL` | no | — | Si está, override de `DATABASE_URL`. |
| `CONFIRMATIONS_INTAKE_TOKEN` | sí | — | Bearer compartido con clinyco_AI / crons. |
| `CONFIRMATIONS_REMINDER_HOURS` | no | `76` | Horas antes de la cita para el recordatorio (ventana ±2h). |
| `CHATWOOT_API_TOKEN` | sí† | — | Token de la cuenta 162472. |
| `CHATWOOT_INBOX_ID` | sí† | — | ID del inbox WhatsApp en Chatwoot Cloud (`107690`). |
| `CHATWOOT_ACCOUNT_ID` | no | `162472` | Override del account id. |
| `CHATWOOT_API_URL` | no | `https://app.chatwoot.com` | Override (self-host). |
| `CHATWOOT_DRY_RUN` | no | `true` | Setear `false` cuando los HSM estén aprobados. |
| `CHATWOOT_HSM_CONFIRM_INITIAL` | no | `cly_confirm_appointment_v1` | Nombre del HSM de 1er mensaje. |
| `CHATWOOT_HSM_CONFIRM_REMINDER` | no | `cly_confirm_reminder_76h_v1` | Nombre del HSM de recordatorio. |
| `ANTHROPIC_API_KEY` | sí‡ | — | Para clasificador Haiku 4.5. |
| `CONFIRMATIONS_CLASSIFIER_MODEL` | no | `claude-haiku-4-5-20251001` | Override de modelo. |
| `CONFIRMATIONS_CLASSIFIER_DRY_RUN` | no | `false` | Forzar fallback heurístico. |
| `CLINYCO_AI_BASE_URL` | sí§ | — | Base URL del VPS clinyco_AI. Se le agrega `/melania/start-from-confirmation`. |
| `CLINYCO_AI_HANDOFF_TOKEN` | sí§ | — | Bearer del endpoint de handoff en clinyco_AI. |

† requeridas solo cuando `CHATWOOT_DRY_RUN=false`.
‡ si falta, el classifier cae al fallback heurístico (cubre >80%).
§ si falta, los reschedule quedan registrados pero no disparan el handoff.

En el lado de **clinyco_AI** (VPS), el endpoint receptor lee
`CONFIRMATIONS_HANDOFF_TOKEN` — debe tener el **mismo valor** que
`CLINYCO_AI_HANDOFF_TOKEN` de este repo.

## Pendientes externos

1. Registrar `cly_confirm_appointment_v1` y `cly_confirm_reminder_76h_v1`
   en Meta Business Manager — ver `docs/whatsapp-templates.md`.
2. Crear inbox WhatsApp en Chatwoot Cloud 162472 y configurar el webhook
   apuntando a `https://sell-medinet-backend.onrender.com/chatwoot-webhook/events`
   (módulo hermano que persiste raw events).
3. En clinyco_AI: añadir endpoint `POST /melania/start-from-confirmation`
   (commit siguiente: rama `claude/continue-project-context-dGU2N`).
4. En clinyco_AI: extender `telemedicine/ingest.js` para hacer
   `POST $SELL_MEDINET_BACKEND_URL/confirmations/intake` cuando detecte
   una cita nueva.

## Archivos

```
confirmations/
├── README.md                  — este archivo
├── index.js                   — createConfirmationsRouter() + auto-migrate
├── db.js                      — pg pool reusable
├── lifecycle.js               — state machine + persistencia (puro, sin Express)
├── classifier.js              — Haiku 4.5 + fallback heurístico
├── chatwoot-client.js         — sendTemplate / findOrCreateContact (dry-run aware)
├── templates.js               — HSM templates + param builders
├── inbound-processor.js       — consume chatwoot.raw_events → classifier → lifecycle
├── scheduler.js               — tick: 1er msg + recordatorio T-76h
├── lib/
│   └── auth.js                — Bearer middleware
├── migrations/
│   ├── 001-schema.sql
│   └── runner.js
└── routes/
    ├── health.js
    ├── intake.js
    ├── process-inbound.js
    └── tick.js
```
