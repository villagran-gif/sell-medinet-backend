# chatwoot-webhook

Módulo receptor de webhooks de Chatwoot (autoalojado en Hetzner).
Es la cabecera de **Fase 1b** del plan de migración — ver
`docs/migration-chatwoot-frappe.md`.

## Responsabilidad

Recibe todos los eventos de una cuenta Chatwoot (mensajes entrantes,
conversaciones creadas/actualizadas, contactos) y los persiste crudos
en `chatwoot.raw_events` para:

1. **Durabilidad**: nada se pierde si un handler falla.
2. **Replay**: los handlers pueden reprocesar eventos cambiando lógica.
3. **Auditoría**: registro completo de qué mandó Chatwoot y cuándo.

**Los handlers normalizados (conversaciones → tickets, mensajes → notas,
contactos → deals en Frappe) NO están implementados todavía**. El scaffold
actual solo persiste eventos. Handlers se agregan en iteraciones siguientes
una vez que tengamos payloads reales.

## Montaje

Es opt-in con `CHATWOOT_WEBHOOK_ENABLED=true`. Ver `server.js`:

```js
if (process.env.CHATWOOT_WEBHOOK_ENABLED === "true") {
  app.use("/chatwoot-webhook", createChatwootWebhookRouter({
    autoMigrate: process.env.CHATWOOT_AUTO_MIGRATE !== "false",
  }));
}
```

Mientras el flag esté apagado el módulo no toca DB ni corre migraciones.

## Variables de entorno

| Var | Requerida | Default | Descripción |
|---|---|---|---|
| `CHATWOOT_WEBHOOK_ENABLED` | sí | `false` | Activa el módulo |
| `CHATWOOT_WEBHOOK_SECRET` | sí | — | Secret compartido para verificar HMAC-SHA256 del body. Generar con `openssl rand -hex 32` y configurar en Chatwoot al crear el webhook |
| `CHATWOOT_WEBHOOK_REQUIRE_SIG` | no | `true` | Si es `false`, se aceptan eventos sin firma verificada (solo para debugging inicial) |
| `CHATWOOT_AUTO_MIGRATE` | no | `true` | Corre `chatwoot.*` DDL al startup |
| `CHATWOOT_DATABASE_URL` | no | — | Si se setea, usa esa conexión. Si no, cae a `DATABASE_URL` (clinyco-db compartida) |

## Endpoints

### `GET /chatwoot-webhook/health`
Liveness + estado de DB.

### `POST /chatwoot-webhook/events`
Recibe eventos desde Chatwoot. Headers esperados:

- `X-Chatwoot-Hmac-Signature: sha256=<hex>` — HMAC-SHA256(rawBody, CHATWOOT_WEBHOOK_SECRET).
  Si falta y `CHATWOOT_WEBHOOK_REQUIRE_SIG=true`, responde `401`.
- `Content-Type: application/json`.

Body: payload de Chatwoot (ver sus docs). Este módulo no asume estructura
específica; lo persiste como JSONB.

Responde `200` (event_id del raw_events) o `401` (firma inválida)
o `4xx/5xx` en errores. Siempre debe responder rápido — el procesamiento
async lo harán los handlers.

## Schema DB

`chatwoot.raw_events` — log append-only de todo lo recibido.
Ver `migrations/001-schema.sql`.

Handlers (cuando existan) van a consumir esta tabla vía cursor
`WHERE processed_at IS NULL ORDER BY received_at`.

## Configurar del lado de Chatwoot

En **Chatwoot Cloud** (`app.chatwoot.com`) o el self-host:

1. Settings → Integrations → Webhooks → **Add new webhook**.
2. URL: `https://sell-medinet-backend.onrender.com/chatwoot-webhook/events`.
3. Subscribed events: marcar `conversation_created`, `conversation_updated`, `conversation_status_changed`, `message_created`, `contact_created`, `contact_updated`.
4. El secret que definiste en Chatwoot debe coincidir con `CHATWOOT_WEBHOOK_SECRET` en Render.

> **Nota 2026-04-26**: el plan oficial es **Chatwoot Cloud Startups** ($190/mo, 10 agentes).
> El self-host quedó deprecado tras decisión del 2026-04-26 (ver `docs/migration-chatwoot-frappe.md` § 0).

## Roadmap

- [x] Scaffold: recibir + firmar + persistir crudo.
- [x] Handler de transcripción para Chatwoot Voice (Twilio + Whisper).
- [ ] Handler `message_created`: mapear a `support.tickets` o tabla propia.
- [ ] Handler `conversation_created`: upsert a `chatwoot.conversations`.
- [ ] Handler `contact_created`/`contact_updated`: sync a Frappe CRM.
- [ ] Backoff + DLQ para handlers que fallen.
- [ ] Metrics: conteo por event_type, lag de procesamiento.

---

## Transcripción de llamadas (Chatwoot Voice)

Cuando una llamada del canal Voice termina, Twilio guarda la grabación y
Chatwoot dispara `conversation_status_changed → resolved`. El handler de
transcripción (fire-and-forget desde `routes/events.js`):

1. Lee la conversación vía Chatwoot API → obtiene `additional_attributes.call_sid`.
2. Busca la grabación en Twilio (`Calls/{sid}/Recordings.json`). Si no está lista, deja el job en `pending`.
3. Descarga el `.mp3`, lo pasa por **OpenAI Whisper**.
4. Postea una **nota privada** en la conversación con el texto transcripto.
5. Persiste todo en `chatwoot.call_transcriptions` (idempotente por `(conversation_id, call_sid)`).

### Variables de entorno

| Var | Requerida | Default | Descripción |
|---|---|---|---|
| `CHATWOOT_TRANSCRIPTION_ENABLED` | sí | `false` | Opt-in del handler |
| `TWILIO_ACCOUNT_SID` | sí | — | Para descargar la grabación |
| `TWILIO_AUTH_TOKEN` | sí | — | Idem |
| `OPENAI_API_KEY` | sí | — | Whisper API |
| `OPENAI_TRANSCRIBE_MODEL` | no | `whisper-1` | Cambia a `gpt-4o-mini-transcribe` para abaratar |
| `CHATWOOT_BASE_URL` | no | `https://app.chatwoot.com` | Base de la API |
| `CHATWOOT_ACCOUNT_ID` | sí | — | ID numérico de tu cuenta Chatwoot |
| `CHATWOOT_API_TOKEN` | sí | — | User Access Token (Profile → Access Token) |

### Endpoints

- `POST /webhooks/chatwoot/transcriptions/run` — disparo manual.
  Body: `{ "conversation_id": 1894, "call_sid": "CA..." }`. Útil para smoke test
  contra una llamada existente sin esperar webhook.
- `POST /webhooks/chatwoot/transcriptions/retry-pending?limit=10` — endpoint
  para cron externo (cada 1 min); procesa pendientes/failed con `attempts < 5`.
- `GET /webhooks/chatwoot/transcriptions/status/:conversation_id` — estado +
  preview (300 chars) del transcript.

### Costos aproximados

- Whisper: USD 0.006/min → ~USD 0.03 por llamada de 5 min.
- A 50 llamadas/día: ~USD 45/mes.

### Cumplimiento (CL)

Recordá avisarle al paciente que la llamada será grabada (Ley 19.628 + 21.521).
Eso se hace del lado de Chatwoot/Twilio en el TwiML inicial, **no acá**.
