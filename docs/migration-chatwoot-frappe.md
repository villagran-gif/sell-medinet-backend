# Migración Zendesk → Chatwoot + Frappe CRM + sell-medinet-backend

**Última actualización**: 2026-04-26
**Branch activa**: `claude/whatsapp-system-user-token-WKAZ7`
**Repos involucrados**:
- `villagran-gif/sell-medinet-backend` (este repo) — bridge/satélite
- `villagran-gif/clinyco_ai` — integración profunda con Zendesk, se migra por URL swap

---

## 0. Decisión final (2026-04-26): Cloud paid, no self-host

Tras 4 días intentando self-host en Hetzner, el equipo decide **pagar Cloud
plans** por Chatwoot y Frappe para tener funcionalidad inmediata.

| | Plan elegido | Costo |
|---|---|---|
| Chatwoot | **Cloud Startups** (10 agentes) | $190/mo |
| Frappe | **Cloud Sites $50** (Frappe CRM, region Frankfurt) | $50/mo |
| **Total Cloud nuevo** | | **$240/mo = $2,880/año** |
| Vs Zendesk actual | $2,200/mo = $26,400/año | |
| **Ahorro neto** | | **$23,520/año** |

### Razones del pivot

1. **WhatsApp Embedded Signup** (solo en Cloud o self-host con flags + dominio
   verificado) destraba el "Invalid Credentials" que bloqueó self-host.
2. **Frappe Cloud entrega site listo en 5 min** vs cloud-init Hetzner que falló
   silencioso 3 veces.
3. **El ahorro vs Zendesk es tan grande ($23k/año) que la diferencia
   self-host vs Cloud ($30 vs $240/mo) es ruido**.
4. **Sin SSH desde sandbox** — debugging self-host requiere acceso humano que
   bloquea el throughput de Claude/Codex.

### Hetzner servers — decommission cuando Cloud esté validado

- `chatwoot-clinyco` (cx23, 91.98.234.232) — destruir tras migrar contactos a
  Chatwoot Cloud.
- `frappe-clinyco` (cx33, 91.98.141.41) — destruir cuando confirmemos Frappe
  Cloud anda. **Cloud-init nunca llegó a correr correctamente, no hay datos
  que perder**.
- Bucket S3 `clinyco-frappe-backups` — se mantiene; Frappe Cloud puede usarlo
  para backups secundarios fuera de Frappe.

### Path partner Frappe Chile (oportunidad lateral)

No hay partners Frappe certificados en Chile (revisado oficial directory
`frappe.io/partners/list` — cero LATAM). Demanda evidente en foros pero sin
oferta. Posible vertical futura: certificarse como Partner y revender el CRM
médico custom a otras clínicas chilenas. Pendiente decisión, no bloqueante.

---

## 1. Decisión estratégica

Reemplazar el stack Zendesk (Sell + Support + Sunshine Conversations) por:

- **Chatwoot** como unified inbox (WhatsApp / Instagram / Facebook) — ya desplegado en Hetzner `91.98.234.232`.
- **Frappe CRM v15** (sin ERPNext) para la UI de agentes comerciales — a deployar en VPS Hetzner CX32 nuevo (~USD 8/mes).
- **sell-medinet-backend** (este repo) como bridge/satélite tipo *strangler fig*, absorbiendo las responsabilidades de Zendesk Support primero y Zendesk Sell después.

### Alternativas descartadas

| Opción | Costo anual | Motivo de descarte |
|---|---|---|
| Frappe Cloud (6 agentes) | ~USD 600 | Caro vs. self-hosted en Hetzner |
| Pipedrive | ~USD 1,700 | Menos extensible, sin open-source |
| Seguir con Zendesk | ~USD 3,960 | Baseline actual — el ahorro justifica migrar |

**Ahorro proyectado**: ~USD 3,800 año 1, ~USD 3,850 año 2+.

---

## 2. Arquitectura objetivo

```
WhatsApp Cloud API (+56 9 2645 9376) ─┐
Instagram DM ─────────────────────────┼─→ Chatwoot ─webhook─→ sell-medinet-backend
Facebook Messenger ───────────────────┘                         ├─ support.* (Postgres espejo)
                                                                ├─ sell.*    (Postgres espejo, NUEVO)
                                                                └─ sync → Frappe CRM (UI agentes)

clinyco_ai (server.js) ──URL swap──→ sell-medinet-backend (sin refactor interno inmediato)
```

La premisa: **no se refactoriza `clinyco_ai` internamente**. Cuando toque flipear, se cambian las URLs base (`ZENDESK_*_BASE_URL`) para que apunten al satélite `sell-medinet-backend`, que expone contratos 1:1 con la API de Zendesk.

---

## 3. Estado actual del repo `sell-medinet-backend`

### Ya hecho (steps 1 - 6a)

- `support-service/` montado en `server.js` con `app.use('/support-service', router)`.
- Postgres schema `support.*` creado (FKs sueltas para espejar Zendesk 1:1).
- Endpoints emulando Zendesk Support API:
  - List / show tickets (sort desc para evitar escaneo histórico).
  - Serialización JSONB, paginación sin límite duro de 1000.
- Script de backfill con scope *tickets abiertos* como primera tanda.
- Endpoints de `sync-log` para mirror mode (diff entre Zendesk y espejo).

### Pendiente

- **Step 6b**: mirror mode *dual-write* activado en `clinyco_ai` (escribir a Zendesk + al satélite).
- **Step 7**: flip `SUPPORT_BACKEND=satellite` y sunset Zendesk Support.
- `sell-service/`: módulo emulando Zendesk Sell (deals, contacts, stages, pipelines) — aún no creado.

---

## 4. Descubrimientos del análisis de `clinyco_ai`

El `server.js` de `clinyco_ai` pesa ~240 KB. La integración con Zendesk es profunda:

### Zendesk Sell — 4 pipelines activos

| Pipeline | ID |
|---|---|
| Bariátrica | 1290779 |
| Balón | 4823817 |
| Plástica | 4959507 |
| General | 5049979 |

### Zendesk Support

- Sync de *lead score* hacia Support.
- Webhooks de ticket → EugenIA (modelo AI Claude/OpenAI) genera notas automáticas.

### Sunshine Conversations

La IA (EugenIA) manda respuestas de WhatsApp vía Sunshine.
Variables env: `SUNCO_APP_ID`, `SUNCO_KEY_ID`, `SUNCO_KEY_SECRET`.
**Decisión**: migración de Sunco al *final*, porque es propiedad de Zendesk y se va con ellos.

### Webhooks ZAPS (Zapier)

- `/zaps/update-comisiones`
- `/zaps/normaliza-rut-contacto`
- `/zaps/rut-normalizado-trato`
- `/zaps/meta-conversion-leads`

Todos deben seguir funcionando durante y después de la migración.

### WAHA (`waha-dev/`, devlikeapro/waha)

Hace análisis de sentimiento + logging de llamadas. **Se mantiene intacto** durante la migración. Decommission en una fase posterior.

### EugenIA (feedback loop)

El modelo aprende de outcomes en Zendesk Sell (deal won/lost, etapas). Este pipeline de feedback **debe preservarse** en Frappe CRM: hay que replicar eventos de deal stage change al mismo destino que usa EugenIA hoy.

---

## 5. Volumen de datos a migrar

| Entidad | Registros |
|---|---|
| Contactos | ~5,000 |
| Deals | ~9,000 |
| Leads | ~19,000 |
| **Total** | **~33,000** |

**Backfill**: estimado 30–60 min con rate limit de Zendesk (~700 req/min).

---

## 6. Stack WhatsApp objetivo

**Número principal**: +56 9 2645 9376 "Centro Médico Clinyco" — ya aprobado en Meta Cloud API.

| Dato | Valor |
|---|---|
| Business Manager ID | 1969811199978170 |
| Meta App ID | 1697421917913182 |
| WABA ID | 472253805966327 |
| Phone Number ID | 470233066166338 |

### Múltiples números detectados en el Business Manager

Se vieron 6 cuentas de WhatsApp en el screenshot del BM:

1. Clínyco
2. Clinyco Whatsapp
3. Centro Médico Clinyco (principal, +56 9 2645 9376)
4. Centro Médico Clinyco (secundario)
5. Centro Médico Clinyco (terciario)
6. Clínyco Salud

**Plan**: arrancar Chatwoot solo con el principal (#3). Los demás se suman en una segunda tanda o se dan de baja según vigencia.

---

## 7. Cómo generar el System User Access Token de Meta

Ruta: [business.facebook.com](https://business.facebook.com) (Meta Business Manager).

### Paso 1 — Ir a Usuarios del Sistema

1. Ícono **⚙️ Configuración de la empresa** (arriba izq).
2. Menú izquierdo → **Usuarios** → **Usuarios del sistema**.
3. URL directa:
   ```
   https://business.facebook.com/settings/system-users?business_id=1969811199978170
   ```

### Paso 2 — Crear el usuario (o reutilizar uno existente)

- Botón **Agregar** (arriba derecha).
- Nombre sugerido: `clinyco-chatwoot-whatsapp`.
- Rol: **Admin**.
- Guardar.

### Paso 3 — Asignar activos

Dentro del System User creado:

**App:**
- **Asignar activos** → tipo: **Apps**.
- Seleccionar la app `1697421917913182`.
- Permiso: **Administrar la app** (control total).
- Guardar.

**Cuenta de WhatsApp (WABA):**
- **Asignar activos** → tipo: **Cuentas de WhatsApp**.
- Seleccionar **Clínyco Salud** (WABA ID `472253805966327`).
- Acceso: **Control total**.
- Guardar.

### Paso 4 — Generar token

Botón **Generar nuevo token**:

| Campo | Valor |
|---|---|
| App | `1697421917913182` |
| Caducidad | **Nunca caduca** |
| Permisos | ✅ `whatsapp_business_messaging` |
| | ✅ `whatsapp_business_management` |
| | ✅ `business_management` (opcional, lectura de config WABA) |

Click **Generar token**.

### Paso 5 — Copiar y guardar

Meta muestra el token **una sola vez**. Guardarlo:
- En Render env var: `META_WHATSAPP_SYSTEM_TOKEN` (service del repo `clinyco_ai`).
- En Chatwoot Super Admin cuando se configure el inbox WhatsApp Cloud.

Formato: ~200 chars, típicamente empieza con `EAAY...`.

### Paso 6 — App Secret

En [developers.facebook.com](https://developers.facebook.com):
- App `1697421917913182` → Configuración → Básica → **Clave secreta de la app** → **Mostrar**.
- Guardar como `META_APP_SECRET`.

---

## 8. Infraestructura actual

### Hetzner VPS Chatwoot

- IP: `91.98.234.232`
- Hostname temporal: `chat.91-98-234-232.sslip.io`
- Docker Compose en `/opt/chatwoot/`
- Root password: `uxRkbmtAFFXa` (validar vigencia antes de usar)
- Disk: 37 GB, 15 % usado
- RAM: 29 % usado
- Load: 0.13

### Render services

- `clinyco_ai` — service principal de IA/integraciones.
- `srv-d68hpvoboq4c73d368k0` — sell-medinet-backend (https://sell-medinet-backend.onrender.com).
- Postgres compartida: `clinyco-db` (usada por ambos services).

### Dominios controlados en Meta

- `clinyco.cl`
- `fonasapad.cl`

Para Frappe: `crm.clinyco.cl` eventualmente. `sslip.io` temporal es aceptable durante el ramp-up.

---

## 9. Plan fásico (strangler fig)

| Fase | Descripción | Días-dev |
|---|---|---|
| 0 | Deploy Frappe CRM en Hetzner CX32 nuevo (paralelo, no destructivo) | 1–2 |
| 1a | Conectar WhatsApp Cloud API (+56 9 2645 9376) a Chatwoot (nativo) | 0.5 |
| 1b | Webhook Chatwoot → sell-medinet-backend para crear contacto/ticket | 2–3 |
| 2a | Completar step 6b: mirror mode dual-write en clinyco_ai | 2–3 |
| 2b | Flip `SUPPORT_BACKEND=satellite` + sunset Zendesk Support | 1 |
| 3a | Construir `sell-service/` en sell-medinet-backend | 5–7 |
| 3b | Dual-write sell-service → Frappe CRM | 3–5 |
| 3c | Backfill Zendesk Sell → `sell.*` Postgres + Frappe CRM (33k records) | 1–2 |
| 4 | Flip `SELL_BASE_URL` en clinyco_ai → satélite | 1 |
| 5 | Decommission subscription Zendesk | 0.5 |

**Total MVP**: 17–25 días-dev.

---

## 10. Convenciones del repo (del `CLAUDE.md`)

- Branches: `claude/<slug>` / `codex/<slug>` / `human/<slug>`. `main` solo por PR.
- **No modificar** endpoints existentes (`/`, `/medinet/*`) salvo orden explícita.
- Módulos nuevos: carpeta autocontenida + 1 sola línea `app.use()` en `server.js`.
- Postgres: schemas separados (`support.*`, `sell.*`) con usuarios dedicados.
- Secretos: solo Render env vars. Nunca en repo.
- Cambios a `render.yaml`, `CODEOWNERS`, `CLAUDE.md`, `AGENTS.md`, `.github/` requieren review humano (CODEOWNERS lo fuerza).
- Auto-deploy prod **apagado** — deploys manuales.
- CI debe pasar antes de merge.

---

## 11. Credenciales pendientes (bloquean avance)

- [ ] `META_WHATSAPP_SYSTEM_TOKEN` (ver sección 7).
- [ ] `META_APP_SECRET` (ver sección 7).
- [ ] PAT GitHub con write a `villagran-gif/sell-medinet-backend`.
- [ ] Copia de env vars del service Render de sell-medinet-backend (Zendesk, DB).
- [ ] Confirmar que Hetzner password sigue siendo `uxRkbmtAFFXa`.
- [ ] Zendesk Sell API token (para backfill eventual en fase 3c).

---

## 12. Primer paso concreto del próximo chat

Arrancar en paralelo Fase 0 (deploy Frappe) + Fase 1a (conectar WhatsApp):

1. Verificar estado del Hetzner actual (SSH, RAM, disk).
2. Decidir: VPS nuevo CX32 para Frappe, o coexistir en el mismo server que Chatwoot.
3. Instalar Frappe Bench + site + app CRM.
4. En Chatwoot Super Admin: crear inbox tipo **WhatsApp Cloud API** con los tokens generados.
5. Validar end-to-end: mensaje de prueba WhatsApp → Chatwoot.

### Prompt sugerido para retomar

> Continuamos migración Chatwoot + Frappe + sell-medinet-backend.
> Leé `docs/migration-chatwoot-frappe.md`.
> Ya tengo: [pegar tokens conseguidos].
> Estado infra: [estado actual].
> Arrancamos por Fase 0 + 1a en paralelo.
