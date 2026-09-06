# Clínyco Integration Gateway

Este repositorio mantiene la capa de integración que conecta **Chatwoot**, **AntonIA/Clínyco AI**, **Medinet**, **Twilio** y automatizaciones de confirmación.

El nombre histórico del repositorio se conserva por compatibilidad con Render y URLs existentes, pero **Zendesk Sell, Zendesk Support, Sunshine Conversations y Frappe no forman parte del runtime**.

## Responsabilidades activas

- Recepción durable de webhooks de Chatwoot.
- Persistencia de eventos crudos en PostgreSQL (`chatwoot.*`).
- Dispatcher por inbox hacia AntonIA y MelanIA.
- Bridge hacia `clinyco_AI` (`POST /chatwoot/inbound`).
- Confirmaciones de citas Medinet vía Chatwoot.
- Bridge Medinet (`/medinet/*`).
- Transcripción de llamadas y automatizaciones de voz vía Twilio/OpenAI.
- TikTok bridge cuando está habilitado.

## Runtime

```text
Chatwoot
  -> /chatwoot-webhook/events
  -> PostgreSQL chatwoot.raw_events
  -> chatwoot-dispatcher
       -> antonia -> clinyco_AI
       -> melania -> confirmations
```

## Endpoints principales

- `GET /` — health básico.
- `POST /medinet/import` — bridge temporal de payload hacia Medinet.
- `GET /medinet/payload/:key` — lectura del payload temporal.
- `POST /medinet/search` — normalización/validación RUN o DNI.
- `/chatwoot-webhook/*` — ingestión Chatwoot, voz y transcripciones.
- `/confirmations/*` — automatización de confirmaciones.
- `/webhooks/*` — integraciones adicionales habilitadas por flags.

## Variables de activación

- `CHATWOOT_WEBHOOK_ENABLED=true`
- `CONFIRMATIONS_ENABLED=true`
- `TIKTOK_BRIDGE_ENABLED=true` cuando corresponda.
- `CHATWOOT_DISPATCH_ROUTES` para mapear inboxes a `antonia` y/o `melania`.

Los secretos viven exclusivamente en variables de entorno de Render. Nunca deben quedar en Git.

## Desarrollo

```bash
npm install
npm test
npm start
```

Node.js >= 18.
