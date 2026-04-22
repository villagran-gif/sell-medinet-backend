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

En el panel de Chatwoot de la cuenta:

1. Settings → Integrations → Webhooks → **Add new webhook**.
2. URL: `https://sell-medinet-backend.onrender.com/chatwoot-webhook/events`.
3. Subscribed events: marcar `conversation_created`, `conversation_updated`, `message_created`, `contact_created`, `contact_updated`.
4. El secret que definiste en Chatwoot debe coincidir con `CHATWOOT_WEBHOOK_SECRET` en Render.

## Roadmap

- [x] Scaffold: recibir + firmar + persistir crudo.
- [ ] Handler `message_created`: mapear a `support.tickets` o tabla propia.
- [ ] Handler `conversation_created`: upsert a `chatwoot.conversations`.
- [ ] Handler `contact_created`/`contact_updated`: sync a Frappe CRM.
- [ ] Backoff + DLQ para handlers que fallen.
- [ ] Metrics: conteo por event_type, lag de procesamiento.
