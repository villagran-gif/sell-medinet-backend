# chatwoot-webhook

Receptor durable de eventos de **Chatwoot Cloud**.

## Responsabilidad

1. Recibir webhooks de Chatwoot.
2. Validar firma cuando está habilitada.
3. Persistir el payload crudo en `chatwoot.raw_events`.
4. Disparar el dispatcher para `message_created`.
5. Activar, cuando corresponda, transcripción de llamadas y follow-up de llamadas perdidas.

## Montaje

`CHATWOOT_WEBHOOK_ENABLED=true` monta el router en `/chatwoot-webhook`.

### Endpoints

- `GET /chatwoot-webhook/health`
- `POST /chatwoot-webhook/events`
- `/chatwoot-webhook/transcriptions/*`
- `/chatwoot-webhook/missed-calls/*`
- `/chatwoot-webhook/twilio/*`

## Variables principales

- `CHATWOOT_WEBHOOK_ENABLED`
- `CHATWOOT_WEBHOOK_SECRET`
- `CHATWOOT_WEBHOOK_REQUIRE_SIG`
- `CHATWOOT_DATABASE_URL` o `DATABASE_URL`
- `CHATWOOT_ACCOUNT_ID`
- `CHATWOOT_API_TOKEN`
- `CHATWOOT_BASE_URL`

### Voz / transcripción

- `CHATWOOT_TRANSCRIPTION_ENABLED`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_TRANSCRIBE_MODEL`
- `CHATWOOT_POLLING_ENABLED`

### Llamadas perdidas

- `CHATWOOT_MISSED_CALL_ENABLED`
- `CHATWOOT_WHATSAPP_INBOX_ID`
- `CHATWOOT_MISSED_CALL_TEMPLATE`

Este módulo no depende de Frappe ni de servicios Zendesk.
