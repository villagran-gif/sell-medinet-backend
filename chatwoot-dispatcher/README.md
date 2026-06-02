# chatwoot-dispatcher

Único consumidor de la cola `chatwoot.raw_events` (eventos `message_created`).
Reclama cada evento una sola vez (FOR UPDATE SKIP LOCKED) y lo **rutea a uno o
más handlers** según el `inbox_id`. Resuelve el problema de que la cola tenía un
solo cursor y un solo consumidor (MelanIA): ahora varios handlers conviven sin
canibalizarse.

## Por qué

Antes, `chatwoot-webhook` disparaba inline el `processInboundQueue` de
`confirmations` (MelanIA), que reclamaba **todos** los `message_created` y los
marcaba procesados. Cualquier segundo consumidor (normalizador de tickets,
Antonia) se quedaba sin eventos. El dispatcher centraliza el claim y hace
**fan-out**: un mismo evento puede ir a varios handlers.

## Behavior-preserving

Sin configuración, **todo va al handler `melania`** — idéntico al comportamiento
previo. Los handlers nuevos solo corren cuando un `inbox_id` se rutea
explícitamente a ellos. Es decir: este módulo se puede mergear y desplegar sin
cambiar nada en producción hasta que se configure el ruteo.

## Handlers registrados

| key | módulo | qué hace |
|---|---|---|
| `melania` | `confirmations/inbound-processor.js` → `handleInboundEvent` | confirmaciones de citas (clasificador Haiku + lifecycle) |
| `support-normalizer` | `support-normalizer/index.js` → `handleInboundEvent` | espeja la conversación a `support.*` (ticket + user + comment) |
| `antonia` | `antonia-bridge/index.js` → `handleInboundEvent` | reenvía a clinyco_AI `POST /chatwoot/inbound` para que Antonia responda por Chatwoot |

Un handler expone `async handleInboundEvent(ev)` con `ev = { id, event_type, payload }`.

## Config (env)

| Var | Default | Descripción |
|---|---|---|
| `CHATWOOT_DISPATCH_ROUTES` | — | JSON `{ "<inbox_id>": ["handler", ...] }`. Mapea inbox → handlers. |
| `CHATWOOT_DISPATCH_DEFAULT` | `melania` | Lista separada por comas para inboxes sin ruta explícita. |

Ejemplo (WhatsApp citas a MelanIA; soporte a normalizador + futuro Antonia):

```
CHATWOOT_DISPATCH_ROUTES={"107690":["melania"],"107767":["support-normalizer"]}
```

## Quién lo invoca

- `chatwoot-webhook/routes/events.js` (auto-trigger inline en cada `message_created`).
- `confirmations/routes/process-inbound.js` (cron: `POST /confirmations/process-inbound`).

Ambos llaman `dispatchPending({ limit })`. `processInboundQueue` queda como shim
deprecado que delega acá, por compatibilidad de imports.

## Roadmap

- [ ] Ampliar el claim a `conversation_created` / `contact_updated` para el normalizador.
- [ ] Handler `antonia` (respuesta IA por Chatwoot) como tercer consumidor.
- [ ] Métricas por handler (lag, throughput) desde el summary.
