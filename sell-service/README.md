# sell-service

Módulo "satellite" que emula la API v2 de **Zendesk Sell** y traduce a
**Frappe Cloud REST API**. Permite migrar gradualmente los 12+ surfaces
de Clínyco que hoy llaman directo a `api.getbase.com` sin reescribirlos.

## Arquitectura

```
[ clinyco_AI    ]──┐
[ box-ai        ] ──→ sell-medinet-backend/sell-service ──→ clinyco.frappe.cloud
[ ZAPS          ]──┘                                          (Frappe CRM)
[ Widget Zendesk]
[ Portal BARRA  ]
[ ...           ]
```

Cada consumer cambia su env var (`SELL_API_BASE`, `ZENDESK_SELL_API_BASE` o equivalente)
de `https://api.getbase.com` → `https://sell-medinet-backend.onrender.com/sell`.
Header de auth: `X-API-Key: <SELL_API_KEY>` (también acepta `Authorization: Bearer`
para compat con código que asumía Zendesk Sell auth).

## Endpoints v0.2 (implementados)

### Meta (read-only)

| Endpoint | Estado | Notas |
|---|---|---|
| `GET /health` | ✅ | sin auth, valida conectividad a Frappe |
| `GET /v2/pipelines [?ids=]` | ✅ | 4 pipelines con IDs Zendesk preservados (1290779, 4823817, 4959507, 5049979) |
| `GET /v2/stages [?pipeline_id=&ids=&per_page=]` | ✅ | IDs sintéticos `pipeline_id*100+position` |
| `GET /v2/contact/custom_fields` | ✅ | derivado de CONTACT_FROM_FRAPPE |
| `GET /v2/deal/custom_fields` | ✅ | derivado de DEAL_FROM_FRAPPE |
| `GET /v2/lead/custom_fields` | ✅ | vacío (Zendesk Lead nunca tuvo custom fields) |
| `GET /v2/users` | ✅ | desde Frappe Users con enabled=1 |
| `GET /v2/lead_sources` | ✅ | filtro `is_for_lead=1` |
| `GET /v2/deal_sources` | ✅ | filtro `is_for_deal=1` |

### CRUD

| Endpoint | Estado | Notas |
|---|---|---|
| `GET /v2/contacts/:id` | ✅ | translator Frappe → Zendesk |
| `GET /v2/contacts?ids=` | ✅ | multi-get |
| `POST /v2/contacts` | ✅ | translator Zendesk → Frappe |
| `PUT /v2/contacts/:id` | ✅ | |
| `GET /v2/deals/:id` | ✅ | |
| `GET /v2/deals?ids=` | ✅ | |
| `POST /v2/deals` | ✅ | con child tables Comisiones (ComisionBAR1-6) y Colaboradores (Colab BAR/PLASTICA/GENERAL/BALON) |
| `PUT /v2/deals/:id` | ✅ | top-level fields only (child tables = v0.3) |
| `GET /v2/leads/:id` | ✅ | |
| `GET /v2/leads?ids=` | ✅ | |
| `POST /v2/leads` | ✅ | acepta custom fields médicos chilenos |
| `PUT /v2/leads/:id` | ✅ | |
| `POST /v2/notes` | ✅ | wrap a FCRM Note de Frappe |

### Search v3 (api.sell.zendesk.com compat)

| Endpoint | Estado | Notas |
|---|---|---|
| `POST /v3/contacts/search` | ✅ (básico) | filtros `eq` simples sobre `custom_fields:RUT_normalizado`, etc. and/or anidados en v0.3 |
| `POST /v3/deals/search` | ✅ (básico) | idem |

## Endpoints pendientes (v0.3)

- DELETE endpoints
- Search queries complejas (and/or anidados, ranges, sort)
- Mirror mode dual-write Zendesk + Frappe
- PUT child tables incremental
- Webhooks outbound para events Frappe → Zendesk-shape

## Variables de entorno

| Var | Required | Default | Uso |
|---|---|---|---|
| `SELL_SERVICE_ENABLED` | sí | `false` | Activa el montaje del módulo |
| `SELL_API_KEY` | sí | — | Header `X-API-Key` que deben mandar los consumers |
| `FRAPPE_SITE_URL` | sí | — | URL del Frappe Cloud (ej: `https://clinyco.frappe.cloud`) |
| `FRAPPE_API_KEY` | sí | — | API Key de Frappe Cloud Sites |
| `FRAPPE_API_SECRET` | sí | — | API Secret de Frappe Cloud Sites |

## Field translation (Zendesk ↔ Frappe)

Ver `lib/translator.js`. Tablas mapeo:

- `CONTACT_TO_FRAPPE` / `CONTACT_FROM_FRAPPE`: 75 fields Zendesk → 27 canonical Frappe
- `DEAL_TO_FRAPPE` / `DEAL_FROM_FRAPPE`: 69 fields Zendesk → ~50 canonical Frappe
- `PIPELINE_ZENDESK_TO_FRAPPE`: 4 IDs numéricos → nombres Frappe

Reglas especiales aplicadas durante write (Zendesk → Frappe):

1. **Bug FECHA DE CIRUGÍA**: si ZAP `update-comisiones` envía `""`, se ignora
   (preserva valor existente en Frappe). Ver `clinyco_AI/ZAPS/update-comisiones/`.
2. **Booleans unificados a OK/PENDIENTE**: `programa_medico_entregado`,
   `documentacion_ingreso`, `validacion_pad`. Mapping:
   - `SI`/`LISTO` → `OK`
   - `NO`/`PENDIENTE` → `PENDIENTE`
   - Excepción `validacion_pad`: `"No aplica..."` → `"NO APLICA"` (3er estado).
3. **Estatura**: si `Estatura` (cm) > 10 → dividir por 100. `PESO (metros)` field
   en Deal es altura mal-nombrada — mapear a `estatura_m` directo.

## Setup en Render

```bash
# Render env vars del service sell-medinet-backend:
SELL_SERVICE_ENABLED=true
SELL_API_KEY=<random 32-char>
FRAPPE_SITE_URL=https://clinyco.frappe.cloud
FRAPPE_API_KEY=<frappe cloud key>
FRAPPE_API_SECRET=<frappe cloud secret>
```

Después en cada consumer (clinyco_AI, box-ai-clinyco, ZAPS):

```bash
# Antes:
SELL_ACCESS_TOKEN=<zendesk-sell-token>
SELL_API_BASE=https://api.getbase.com

# Después:
SELL_API_KEY=<misma SELL_API_KEY del satellite>
SELL_API_BASE=https://sell-medinet-backend.onrender.com/sell
```

## Smoke test

```bash
# Probar que llega a Frappe
curl https://sell-medinet-backend.onrender.com/sell/health

# Listar pipelines (auth requerida)
curl -H "X-API-Key: $SELL_API_KEY" \
  https://sell-medinet-backend.onrender.com/sell/v2/pipelines
```

## Roadmap

- v0.1 (este commit): scaffold + meta endpoints
- v0.2: CRUD contacts/deals/leads + notes
- v0.3: Search API v3
- v0.4: Mirror mode dual-write (Zendesk + Frappe en paralelo durante validación)
- v0.5: Flip definitivo + decommission Zendesk Sell
