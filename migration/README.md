# migration/

Artefactos para la migración Zendesk Sell + Support → Frappe CRM + Chatwoot Cloud.

## Archivos

### `frappe-schema.json`

Spec target del schema Frappe CRM tras migración. Incluye:

- **lead_sources** (24 items): combinación de los 14 lead-sources + 21 deal-sources de
  Zendesk, deduplicados, con flags `is_for_lead` / `is_for_deal`.
- **lead_statuses** (7 items): flujo Clinyco para leads (Nuevo → Calificando → Calificado → Convertido / Descalificado / Sin Respuesta / Junk).
- **deal_statuses** (8 items): mapeo cross-pipeline desde 30 stages Zendesk
  (Candidato → Examenes Solicitados → Examenes Recibidos → Pre-Operatorio →
  Cerrado Agendado → Cerrado Operado / Suspendido / Sin Respuesta).
- **custom_fields**:
  - `CRM Lead Source` (+2 fields: `is_for_lead`, `is_for_deal`)
  - `CRM Lead` (+11 medical fields)
  - `Contact` (+19 canonical fields tras dedup de los 75 originales Zendesk)
  - `CRM Deal` (+38 canonical fields, varios con `fetch_from` desde `contact.*` para
    auto-syncing de previsión, tramo, RUT, antropométricos)
- **child_doctypes** (3 nuevos):
  - `Clinyco Comision` (consolida ComisionBAR1-6)
  - `Clinyco Colaborador` (consolida Colaborador 1-3 × 4 pipelines)
  - `Cirugia Previa Item` (catálogo multi-select)
- **server_scripts** (6):
  - `rut_normalizado` × 2 (Contact + Deal) — algoritmo módulo 11 chileno
  - `imc` × 2 (Contact + Deal) — peso / estatura²
  - `diff_dias_deal` — fecha_cirugia − fecha_hito_2
  - `whatsapp_link_deal` — mantiene compatibilidad con ZAP `update-comisiones`

### `_apply_order` (en frappe-schema.json)

Orden recomendado para aplicar el schema (delete defaults → child doctypes →
custom fields → items → server scripts).

## Status

🟡 **Para review humano antes de aplicar**.

Campos que requieren verificación antes de ejecutar:
- `Sucursal` options (3 valores en Zendesk — confirmar nombres reales)
- `cirugia_procedimiento` opciones (17 choices Zendesk a exponer como Select)
- `prevision` options (verificar si las 7 listadas cubren los 17 choices Zendesk)
- `tramo_modalidad` options (idem 17 choices)
- Lead/Deal status colors (cosméticos)
- Códigos hardcoded ZAP comisiones (8001, 5002-6006) — verificar con contabilidad

## Aplicación

Una vez confirmado, se aplica vía API Frappe Cloud usando el orden de
`_apply_order`. Por ahora **no hay script automatizado** — se aplica via curl
calls a `frappe.client.insert` y similares.

Próximo paso: crear `apply-schema.js` (Node) que parsea este JSON y hace los
calls API en orden, idempotente (skip si ya existe), con dry-run mode.

## Caveats

- Frappe CRM (FCRM) no tiene `CRM Deal Source` doctype, solo `CRM Lead Source`.
  Reutilizamos ese mismo doctype con flag `is_for_deal` para deal sources.
- `fetch_from` en CRM Deal funciona porque CRM Deal tiene un Link `contact`
  hacia `Contact`. Replica automáticamente al cambiar el Contact vinculado.
- El bug heredado del ZAP `update-comisiones` que escribe `FECHA DE CIRUGÍA = ""`
  cada update se mitiga en el `sell-service/` satellite (Fase 2), NO acá.
- Multi-select Contact/Deal field `cirugias_previas` requiere que el child
  doctype `Cirugia Previa Item` exista PRIMERO.

## Referencias

- `docs/migration-chatwoot-frappe.md` § 13 (schema source)
- `docs/migration-chatwoot-frappe.md` § 14 (custom fields críticos × servicios)
- `docs/migration-chatwoot-frappe.md` § 15 (plan ejecución consolidado)
- `/tmp/zendesk-schema/*.json` (extracción raw — no commiteada, regenerable
  desde `https://api.getbase.com/v2/{contact|deal|lead}/custom_fields`)
