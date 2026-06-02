# support-normalizer

Handler del `chatwoot-dispatcher` que **espeja conversaciones de Chatwoot Cloud
(cuenta 162472) a `support.*`** en shape Zendesk. Es el eslabón que faltaba para
que el satélite `support-service` refleje **Chatwoot** y no solo el backfill
histórico de Zendesk: cuando `clinyco_AI` flipee `SUPPORT_BACKEND=satellite`,
leerá los tickets que originó Chatwoot.

## Mapeo

| Chatwoot Cloud (162472) | → | `support.*` |
|---|---|---|
| `conversation` (id, status, inbox) | → | `support.tickets` (1 conversación = 1 ticket, `chatwoot_conversation_id` único) |
| `sender` / `contact` (id, name, phone, email) | → | `support.users` (`chatwoot_contact_id` único) |
| `message` (content, message_type, private) | → | `support.ticket_audits` + `support.ticket_events` (type `Comment`) |

- `message_type: incoming` → comentario del paciente; `outgoing` → del agente.
- `private: true` → comentario no público (nota interna).
- `status`: `open→open`, `resolved→solved`, `pending→pending`, `snoozed→hold`.

## Idempotencia

- User y ticket se **upsertean** por id de Chatwoot (unique index parcial creado
  en `support-service/migrations/004-chatwoot-source.sql`).
- Cada `message_created` se procesa una sola vez porque el dispatcher reclama el
  `raw_event` con `processed_at` (at-most-once).
- **Limitación conocida**: si un mismo `raw_event` se reprocesara, el comentario
  se duplicaría. Dedupe por `chatwoot message id` (unique en `ticket_events`)
  queda como mejora futura.

## Activación

Dormant por default. Para enrutar un inbox a este handler:

```
CHATWOOT_DISPATCH_ROUTES={"<inbox_id_soporte>":["support-normalizer"]}
```

Ver `chatwoot-dispatcher/README.md`. La migración aditiva la corre el runner de
`support-service` (`npm run migrate:support`) — solo agrega columnas e índices,
no toca datos existentes.

## Archivos

```
support-normalizer/
├── README.md
├── map.js     — payload Chatwoot → forma canónica (pure, testeado)
├── db.js      — upsert user/ticket + append comment (1 tx, DML sobre support.*)
└── index.js   — handleInboundEvent(ev) para el dispatcher
```

## Scope / próximos

- [ ] `conversation_created` / `conversation_status_changed` para reflejar estado sin esperar un mensaje.
- [ ] `contact_updated` → sync de `support.users`.
- [ ] Adjuntos (hoy se omiten los mensajes sin texto).
- [ ] Dedupe por message id.
