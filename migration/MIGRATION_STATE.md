# Migration State — Zendesk Sell + Support → Frappe FCRM

**Read this BEFORE any work on FCRM / migration / customization.**

Last updated: 2026-05-04. Branch: `claude/whatsapp-system-user-token-WKAZ7` (PR #10).

## 1. Site

- URL: `https://crm-yqh-dgj.m.frappe.cloud`
- Plan: Frappe Cloud **Managed shared** (`.m.` in subdomain)
- Frappe version: **16.17.2** | FCRM version: **1.70.0**
- API credentials: env vars `FRAPPE_CLOUD_SITE_URL`, `FRAPPE_CLOUD_API_KEY`, `FRAPPE_CLOUD_API_SECRET` (per-user API key from `/desk` → My Settings → API Access).

The original site `clinyco.frappe.cloud` was deprecated; this is a NEW Frappe Cloud site. Don't touch the previous URL.

## 2. Data state (counts)

| Doctype | Count | Source | Notes |
|---|---|---|---|
| Contact | 8,802 | 8,807 | 5 dropped por homonimia (autoname collision) |
| CRM Deal | 4,691 | 4,691 | 100% |
| CRM Lead | 18,147 | 18,166 | 99.9% |
| FCRM Note | 12,062 | 12,062 | 100% |
| CRM Task | 6,860 | 6,896 | 99.5%; 6,573 linked a deal vía reference_doctype/docname; 763 Pendiente / 6,097 Realizada |
| File (binarios docs) | 395 | 395 | PDFs/imgs descargados de Sell API + uploaded a Frappe |
| Zendesk Ticket | 59,383 | 59,536 | Custom doctype; 7,974 con contact link, 7,202 con deal link |

## 3. Schema — Custom Doctype

**`Zendesk Ticket`** (FCRM module): metadata-only de tickets de Support.
Campos: `zendesk_ticket_id` (unique, indexed), `subject`, `status` (Select: New/Open/Pending/Hold/Solved/Closed), `channel` (Voice/WhatsApp/Facebook/Instagram/Messaging/Web/Email/Api), `requester_email`, `contact` (Link Contact), `deal` (Link CRM Deal), `requester_id`, `assignee_id`, `submitter_id`, `organization_id`, `form`, `group_name`, `brand`, `priority`, `created_at`, `updated_at`, `solved_at`, `first_reply_minutes`, `full_resolution_minutes`, `satisfaction_score`, `recipient`, `tags`, `external_id`. Body de tickets NO está acá (queda en Postgres clinyco_AI/support — strangler fig).

## 4. Schema — Custom Fields per doctype

| Doctype | Custom fields | Notas |
|---|---|---|
| Contact | 46 zd_* (Data/Small Text) + canonicals (rut_normalizado, zendesk_id_contact) | 13 hidden por low coverage |
| CRM Deal | 95 Data + 2 Select (cero Long Text). Borrados 41 legacy garbage fields | Plus canonicals: rut_normalizado, zendesk_id_deal, zendesk_id_main_contact, pipeline_name, status (Link CRM Deal Status), organization (Link CRM Organization, label "Pipeline") |
| CRM Lead | 79 zd_* | sin tocar layout |
| FCRM Note | 12 zd_* | reference_doctype/reference_docname (Dynamic Link) |
| CRM Task | 13 zd_* + canonicals + 3 deal_* (deal_lead_name, deal_rut, deal_phone) | track_changes=1 activo |
| Zendesk Ticket | 22 fields nativos | doctype custom |
| CRM Deal Status | + zendesk_stage_id, zendesk_pipeline_id, zendesk_pipeline_name | trazabilidad |

**Long Text → Data conversion**: Frappe bloquea cambio directo. Path 2-step: `Long Text → Small Text → Data`. Converti 220+ fields. Si MySQL row size limit (1118 error): queda como Small Text.

## 5. Pipeline + Stages

4 CRM Organization records (renombrados): `Bariátrica`, `Balones`, `General`, `Plástica`.

30 CRM Deal Status records con prefix:
- `BAR -` (8 stages, blue color, 4047 deals)
- `BAL -` (8, orange, 202)
- `GEN -` (7, green, 150)
- `PLA -` (7, violet, 292)

Cada stage tiene `zendesk_stage_id`, `zendesk_pipeline_id` para trazabilidad.

## 6. Layouts del CRM Deal

- **CRM Deal-Data Fields** (tab Datos): 11 secciones (Paciente, Estado del deal, Cirugía, Equipo médico, Datos médicos, Hitos & seguimiento, Documentos & links, Comisiones BAR, Colaboradores, Observación, Zendesk metadata). Usa `zd_*` exclusivamente (legacy canonicals tenían garbage default).
- **CRM Deal-Side Panel** (panel derecho): 11 secciones stack vertical estilo Zendesk (Contactos asociados, Identificación, Estado, Operacional, Equipo médico, Datos médicos, Hitos, Links, Colaboradores BAR, Comisiones, Observaciones).

## 7. List View `/crm/deals/view/list` (CRM View Settings ID 3)

50 columns curadas. Todas usan `zd_*` para datos médicos/operacionales. `order_by zd_created_at desc`. `public=1 is_default=1` (pinned=0 por feedback usuario).

Quick filter row hardcodeado por FCRM (no se puede agregar via Property Setter). Workaround: Form Script `deal_search_name_rut` agrega inputs Buscar Nombre + Buscar RUT arriba del filter row.

## 8. CRM Form Scripts activos

| Name | dt | view | función |
|---|---|---|---|
| `deal_zendesk_column_filters` | CRM Deal | List | Click en column header → popup Zendesk-style con Sort + Con/Sin valor + filtros relativos |
| `deal_search_name_rut` | CRM Deal | List | Inputs de búsqueda Nombre + RUT arriba del filter row |
| `color_pipeline_deal` | CRM Deal | List | Colorea avatar/texto del Pipeline (Bariátrica=blue, Balones=orange, General=green, Plástica=violet) y stages "BAR -"/"BAL -" en el mismo color |
| `hide_column_picker_deal` | CRM Deal | List | Oculta botón "Columnas" |
| `show_tickets_deal` | CRM Deal | Form | Inyecta panel "Tickets en Support (N)" con tickets linkeados al deal |
| `show_tickets_contact` | Contact | Form | Idem para contacts |
| `task_deal_clickable` | CRM Task | List | Hace celdas con CRM-DEAL-... clickeables; click en row → /crm/deals/<name>?viewType=list#tasks |

## 9. Property Setters aplicados

- `CRM Deal.title_field = lead_name`
- `CRM Deal.organization` label = "Pipeline"
- `CRM Deal.lead_name` in_standard_filter=1, in_list_view=1
- `CRM Deal.rut_normalizado` in_standard_filter=1, in_list_view=1
- `Contact.rut_normalizado` in_standard_filter=1
- `Contact.full_name` in_standard_filter=1
- `CRM Task.status.options = "\nPendiente\nRealizada"` + `default = Pendiente`
- `CRM Task.track_changes = 1`
- `CRM Lead.label = "Leads"` (no aplicó al sidebar — FCRM usa traducciones)
- `CRM Organization.label = "Pipeline"` (no aplicó al sidebar)
- `Contact.restrict_to_domain = 1` (intento hide sidebar — sin verificar)
- `FCRM Note.restrict_to_domain = 1` (intento hide sidebar — sin verificar)

## 10. Translation overrides (es/es-419)

- `Leads & Deals` → `Leads`
- `Leads & Customers` → `Leads`
- `Clientes potenciales` → `Leads`
- `Leads` → `Leads` (override directo)
- `Organizations` → `Pipelines`
- `Organisations` → `Pipelines`

User confirmó: "Organizations → Pipelines" funcionó. "Clientes potenciales → Leads" funcionó después de la traducción `Leads → Leads`.

## 11. CRM View Settings (cleanup post-feedback)

- ID 1 (CRM Lead Lista): public=0, pinned=0
- ID 2 (Contact Lista): public=0, pinned=0
- ID 3 (CRM Deal Lista): public=1, is_default=1, pinned=0 (50 cols)
- ID 4 (CRM Deal group_by Agrupar por): **DELETED**
- ID 5 (CRM Task Lista): public=1, is_default=1, 10 cols incl Deal column

## 12. Decisiones tomadas

- **B2C, no B2B**: borradas todas las secciones "Organization Details" del side panel; `organization` field repurposed como Pipeline.
- **v16 stays**: usuario rechazó downgrade a v15 — bugs son del FCRM frontend, no del backend.
- **Solo Deals matter**: 90% del trabajo del agente es en Deals. Foco en Deal UI. Contact/Lead son secundarios.
- **Hybrid Support**: tickets metadata en Frappe + body en Postgres clinyco_AI (strangler fig de support-service).
- **Borrados 41 legacy garbage fields** de CRM Deal. Server scripts asociados (rut_normalizado_deal, imc_calc_deal, diff_dias_deal, whatsapp_link_deal) **disabled**.
- **Software se adapta a la cultura, no al revés**: replicar UX Zendesk vía JS injection accepted.

## 13. Pendiente

- **Sidebar hide Contactos+Notas**: Property Setter `restrict_to_domain=1` aplicado pero sin verificar. Si no funciona: investigar `hide_in_navbar` flag o `FCRM Settings`.
- **Buscador global**: FCRM Cmd+K reportado como no funciona; revisar.
- **Tickets en Support panel**: Form Script `show_tickets_deal` puede no estar matcheando los selectores CSS correctos. Validar.
- **Phone update en CRM Task**: ejecutado en background; verificar que `deal_phone` está populado.

## 14. Limitaciones conocidas

- **FCRM frontend hardcoded**: sidebar items, quick filter row, layout structural — sin acceso bench (Frappe Cloud Managed) NO se modifica via API. Workarounds via JS injection son frágiles.
- **MySQL row size 65535 bytes**: limita cantidad de campos Data (varchar inline) por doctype.
- **Frappe restringe Long Text → Data direct**. Path requerido: `Long Text → Small Text → Data`.
- **CRM Form Scripts solo corren en su dt+view específico**. No hay mecanismo de "global script".
- **REST DELETE en /api/resource/Custom Field falla** con 404 — usar `frappe.client.delete` POST.
- **URL path con `+` se interpreta literal** (no como espacio). Usar `%20` para `Custom%20Field`. En query string el `+` es OK.
- **Concurrent inserts hit naming series deadlocks** — usar workers≤4 en bulk imports.
- **Issue #1884 frappe/crm**: list view lag con >200 records en v1.70. Open, sin fix upstream.
- **Property Setter sobre DocType.label NO afecta sidebar FCRM** — usar Translation doctype con source matchando texto visible.

## 15. Files in `migration/`

| Path | Función |
|---|---|
| `import-from-csv.py` | Original Sell import (legacy, parchado) |
| `import-from-zendesk.py` | Original API import (legacy) |
| `dedupe-contacts.py` | Dedupe by RUT (legacy) |
| `add-unique-constraint.py` | Add unique on rut_normalizado (legacy) |
| `resolve-deal-contacts.py` | Link deals to contacts (legacy) |
| `frappe-schema.json` | Schema reference |
| `sample-export.py` | Random sample 1000+1000 |
| `probe-import.py` | Schema gap probe |
| `findings-2026-05-03.md` | Probe findings doc |
| `audit-fidelity.py` | 50-contact migration audit (100% preserved) |
| `discovery.py` | Full source CSV discovery |
| `schema-setup.py` | Custom Fields creation (FCRM v15+ aware) |
| `import-full.py` | Raw mirror import per entity (--entity contacts/deals/leads/notes/tasks) |
| `import-documents.py` | 395 binaries via Sell API → Frappe File |
| `setup-list-view.py` | Contact/Lead list view config |
| `setup-deal-list-view.py` | Deal list view (50 cols, zd_* preferred) |
| `setup-deal-layout.py` | Deal Datos+Side Panel layout |
| `setup-pipeline-stages.py` | 30 BAR/BAL/GEN/PLA stages + deal migration |
| `setup-task-list-view.py` | Task list view con Deal column |
| `delete-trash-fields.py` | Borrar 66 trash CFs en Contact |
| `cleanup-deal-legacy-fields.py` | Borrar 41 legacy garbage fields en Deal |
| `clear-cf-descriptions.py` | Quitar descripciones de auditoría |
| `optimize-fieldtypes.py` | Long Text → Small Text/Data conversion |
| `hide-low-coverage-fields.py` | hidden=1 en zd_* low-coverage |
| `color-stages-by-pipeline.py` | Color BAR/BAL/GEN/PLA |
| `customize-sidebar.py` + `customize-sidebar-v2.py` | Form Script + Property Setters intento sidebar |
| `verify.py` | Counts vs source post-import |
| `reset-site.py` | Bulk delete (con --execute) |
| `import-tickets.py` | Importar 59k tickets de Support |
| `link-tickets-to-deals.py` | Linkear tickets a deals via single-deal contacts |
| `quick-filters-search.py` | Property Setters in_standard_filter |
| `hide-column-picker.py` | Form Script hide Columnas button |
| `set-user-defaults.py` | Setea defaults UI para todos los users habilitados (`desk_theme=Dark` + `default_app=crm`) + Property Setters equivalentes para users nuevos (idempotente, --execute) |

## 16. Next session — workflow recomendado

1. Leer este doc completo + `migration/SESSION_HISTORY.md`
2. Site URL + credenciales: env vars (NO hardcoded en repo)
3. Source CSVs en `/tmp/zendesk-export-new/` (Sell) y `/tmp/zendesk-support/extracted/` (Support)
4. Mapping outputs en `/tmp/migration/` (`contact_id_map.json`, `deal_id_map.json`, `lead_id_map.json`, `stage_id_to_status.json`, `discovery.json`)
5. Para customización del sidebar: usar Translation doctype, NO Property Setter sobre Doctype.label
6. Para nuevas migraciones: workers≤4, idempotente por `zendesk_id_*`
7. Si list view freezes: chequear URL >4094 bytes (nginx) o Long Text rendering
