# support-service

Módulo satélite que reemplaza Zendesk Support de forma incremental
(strangler fig). Vive dentro de `sell-medinet-backend` y se monta como
router Express en `server.js` — **opt-in vía `SUPPORT_ENABLED=true`**.

## Filosofía

- **Espejo 1:1 de Zendesk Support API**: rutas y JSON idénticos. El flip
  final en `clinyco_ai` es solo cambiar la URL base.
- **Aislado**: carpeta autocontenida. No importa nada del runtime de
  Medinet existente.
- **Dormido por default**: si `SUPPORT_ENABLED` no es `"true"`, no se
  monta y no toca DB.

## Variables de entorno

| Variable                | Requerido | Default | Descripción                                           |
|-------------------------|-----------|---------|-------------------------------------------------------|
| `SUPPORT_ENABLED`       | sí (para activar) | `false` | Si `"true"`, monta el router en `/support`.   |
| `SUPPORT_DATABASE_URL`  | sí        | —       | Postgres connection string. Cae a `DATABASE_URL` si no está. |
| `SUPPORT_API_KEY`       | sí        | —       | Clave para header `X-API-Key`.                        |
| `SUPPORT_AUTO_MIGRATE`  | no        | `true`  | Corre migraciones al boot. Setear `"false"` para skip. |
| `SUPPORT_DB_POOL_MAX`   | no        | `5`     | Conexiones máximas del pool (limítrofe para no agotar prod). |
| `SUPPORT_DB_SSL`        | no        | auto    | Forzar `"true"` si la URL no es Render/AWS pero requiere SSL. |

## Endpoints (espejo Zendesk)

Mount en `/support`. Rutas internas en `/api/v2/*`.

| Método | Ruta                                     | Auth          |
|--------|------------------------------------------|---------------|
| GET    | `/support/health`                        | sin auth      |
| GET    | `/support/api/v2/users/:id`              | `X-API-Key`   |
| PUT    | `/support/api/v2/users/:id`              | `X-API-Key`   |
| GET    | `/support/api/v2/users/:id/identities`   | `X-API-Key`   |
| POST   | `/support/api/v2/users/:id/identities`   | `X-API-Key`   |

Próximas (PRs siguientes): `tickets`, `tickets/:id/audits`,
`tickets/:id/comments`, `users/search`, `search.json`.

## Esquema Postgres

Schema dedicado `support.*`:

- `support.users`
- `support.user_identities`
- `support.tickets`
- `support.ticket_audits`
- `support.ticket_events`
- `support.migrations` (control de migraciones)

Ver `migrations/001-schema.sql`.

## Migraciones

Idempotentes, registradas en `support.migrations`.

```bash
# Manualmente:
npm run migrate:support

# Auto al boot del servidor (default si SUPPORT_ENABLED=true):
SUPPORT_ENABLED=true SUPPORT_AUTO_MIGRATE=true npm start
```

## Cómo se monta

`server.js` (1 sola línea condicional):

```js
import { createSupportRouter } from "./support-service/index.js";

if (process.env.SUPPORT_ENABLED === "true") {
  app.use("/support", createSupportRouter());
}
```

## Estructura

```
support-service/
├── README.md
├── index.js                # createSupportRouter()
├── db.js                   # pg.Pool lazy
├── migrations/
│   ├── 001-schema.sql
│   ├── runner.js
│   └── cli.js              # npm run migrate:support
├── lib/
│   ├── auth.js             # X-API-Key middleware
│   ├── errors.js           # HttpError, asyncHandler, errorHandler
│   └── zendesk.js          # mapeos row → JSON Zendesk
└── routes/
    ├── health.js
    └── users.js
```

## Plan general (estado)

| Paso | Descripción                                | Estado |
|------|--------------------------------------------|--------|
| 1    | Schema + migrations runner + auth + users  | ✅ este PR |
| 2    | Tickets, audits, comments                  | pendiente |
| 3    | Search (users, search.json)                | pendiente |
| 4    | Cliente HTTP en `clinyco_ai` con flag      | pendiente |
| 5    | Backfill desde Zendesk                     | pendiente |
| 6    | Mirror mode: dual-write + diff log         | pendiente |
| 7    | Flip a satélite + apagar Zendesk           | pendiente |
