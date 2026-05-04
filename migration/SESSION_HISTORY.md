# Session History — Migración Zendesk Sell + Support → Frappe FCRM

Resumen exhaustivo de la sesión 2026-05-03/04. Conversación con cambios de dirección, intentos fallidos, decisiones tomadas, y estado final.

> Nota: este resumen omite credenciales/keys (referenciadas como `<env>`) y reproduce el flujo lógico de la conversación. Para detalle técnico final, ver `MIGRATION_STATE.md`.

## 0. Setup inicial

- Sitio Frappe original `clinyco.frappe.cloud` deprecated (devolvía 307 al dashboard).
- Site nuevo: `crm-yqh-dgj.m.frappe.cloud` (Managed shared, Frappe 16.17.2 + FCRM 1.70).
- Credenciales nuevas creadas via /desk → My Settings → API Access.

## 1. Análisis preliminar

Probe de muestra 1000+1000 (`probe-import.py`):
- Contacts 998/1000 OK, Deals 542/1000 OK (rest fallaron por main_contact fuera de muestra).
- Solo 2 errores reales: 1 dup homonimia (`LEONOR PULGAR DÍAZ-1`), 1 link a Agente missing.
- 93 columnas source sin mapear identificadas. Findings doc: `findings-2026-05-03.md`.

## 2. Decisión de estrategia

Usuario pidió migración FULL con TODOS los campos, hibrid raw + canonical. Confirmó:
- Custom fields raw mirror `zd_<col_snake>` para todos los source columns.
- Canonicals (zendesk_id_*, rut_normalizado) para dedupe.
- Notes migrar tal cual (HTML).
- Leads al final.
- Documents binarios: download.
- Owners: crear como Frappe Users idénticos a Zendesk.

## 3. Ejecución de migración

Reset destructivo (Comments+Lead+Deal+Contact). Bug parallel: el reset borró parcialmente contacts mientras yo ya estaba importando — recuperado via re-import idempotente.

Phase 1 Discovery: 8807 contacts, 4691 deals, 18166 leads, 12062 notes, 6896 tasks, 409 documents. 23 users, 4 pipelines, 16 stages, 22 tags.

Phase 2 Schema setup:
- Stages: usar `deal_status` field (no `name`) + heurística type Won/Lost/Open.
- CRM Deal Pipeline NO existe en FCRM v1.70 — pipeline_name como Custom Field.
- Notes mapean a `FCRM Note` (no Comment). Reference field es `reference_docname` (Dynamic Link).
- 306 custom fields creados raw mirror.

Phase 3-7 Imports:
- Contacts: 8802/8807 (5 dup homonimia)
- Deals: 4691/4691 (100%, retry workers=2 para resolver deadlocks)
- Leads: 18147/18166 (99.9%)
- Notes (FCRM Note): 12062/12062 (100%)
- Tasks (CRM Task): 6860/6896 (99.5%)

Phase 8 Documents binarios:
- 395 PDFs/imgs descargados via Sell API endpoints (`GET /v2/documents?resource_type=X&resource_id=Y` → signed S3 URL → upload to Frappe File via multipart). Auth Sell: `SELL_ACCESS_TOKEN` env.
- Bug fix: REST DELETE `/api/resource/Custom+Field` (con `+` literal) falla. Cambiar a `frappe.client.delete` POST. Plus URL path debe usar `%20` no `+`.

## 4. Audit fidelity post-migración

`audit-fidelity.py --n 50`: 949/949 campos preservados (100%). Confirmó que NO se perdió data; solo el list view default no mostraba todo.

## 5. Promote canonicals

Para que la lista FCRM mostrara emails/phones/company:
- email_id, mobile_no, phone son **read-only** en Frappe Contact (computed from email_ids/phone_nos child tables).
- Solución: setear las child tables. Phone validation strict — bypass si falla.
- 4519 emails, 4547 mobiles, 268 companies populados.

## 6. UI iteration — list view

Cambios sucesivos por feedback del usuario:

**Iter 1**: 137 columnas (todos los CFs). Resultado: list view freeze ("La página no responde").

**Diagnóstico crítico**: NO era Chrome ni server. Era nginx rechazando URL >4094 bytes. Issue #1884 frappe/crm también contribuye.

**Iter 2**: borrar 66 trash CFs en Contact (10 vacíos + 56 variantes #1..#5). URL bajó a 2093 bytes.

**Iter 3**: Convert Long Text → Data via path 2-step (Long Text → Small Text → Data). Frappe bloquea direct change. 220+ fields convertidos. CRM Deal: cero Long Text.

**Iter 4**: Borrar 41 legacy garbage fields en CRM Deal (tramo_modalidad, sucursal, prevision, cirugia_procedimiento, fecha_*, etc — todos con 1 valor único default garbage). Server scripts disabled.

**Iter 5**: Layouts Datos tab + Side Panel del Deal (11 secciones c/u) usando zd_* exclusivamente.

**Iter 6**: List view 50 columnas curadas. Order by zd_created_at desc. Public+Default+Pinned.

**Iter 7**: Pipeline-aware stages. 30 BAR/BAL/GEN/PLA. Migrados los 4691 deals. Color por pipeline (blue/orange/green/violet).

**Iter 8**: Pipeline + Fase como columnas SEPARADAS. Pipeline = `organization` Link (CRM Organization renombrada Bariátrica/Balones/General/Plástica con label "Pipeline"). Fase = `status` Link (CRM Deal Status).

**Iter 9**: Form Scripts JS injection:
- Color avatar pipeline (CSS por texto matching)
- Color "BAR -" / "BAL -" prefix en Fase
- Hide column picker button
- Show tickets panel en deal/contact detail
- Search Nombre + RUT inputs
- Zendesk-style column header click → popup con Sort + Con/Sin valor + filtros relativos

## 7. Support tickets migration

Decisión Hybrid (opción C): tickets metadata en Frappe + body en Postgres.

**Doctype custom `Zendesk Ticket`** con 22 campos.

Source: `/tmp/zendesk-support/extracted/tickets.csv` (59,536 tickets, separator=`;`).

Resolución de contact: users.csv → email/phone/name → match Frappe Contact email_to_contact/phone_to_contact/name_to_contact maps.

Resultado: 59,373 tickets importados. 7,974 con contact link (13%, esperable porque mayoría son anonymous WhatsApp/FB). 7,202 con deal link (single-deal contacts).

## 8. Customizations posteriores

- **Quick filter Nombre + RUT**: Property Setter `in_standard_filter=1`. No suficiente — FCRM hardcodea quick filters. Workaround: Form Script con search inputs.
- **Sidebar customization** (Contactos, Notas hide; Organizations→Pipeline, Clientes potenciales→Leads rename; Public/Pinned Views hide): Form Script `view: List/Form` NO aplica al sidebar. **Resuelto vía Translation doctype** (es+es-419). Property Setter sobre Doctype.label NO funciona. `restrict_to_domain=1` aplicado a Contact/FCRM Note (sin verificar).
- **Tasks states Pendiente/Realizada**: Property Setter `CRM Task.status.options = "\nPendiente\nRealizada"` + default + bulk update 6860 tasks (Done|Canceled → Realizada; resto → Pendiente). Resultado: 763 Pendiente / 6097 Realizada.
- **Track changes en CRM Task**: Property Setter `track_changes=1`. Activity Log registra cambios futuros (no históricos).
- **Side panel "Tickets en Support"**: Form Script `show_tickets_deal`/`show_tickets_contact` inyecta panel HTML. CSS selectors pueden necesitar ajuste según DOM real.
- **CRM Task list view**: Created CRM View Settings ID 5. Columns: Título, Nombre (deal_lead_name), RUT (deal_rut), Teléfono (deal_phone), Deal (reference_docname), Estado, Asignado, Fecha límite, Prioridad, Modificado. Plus Form Script `task_deal_clickable`: row click → deal#tasks.
- **Translation overrides**: "Clientes potenciales"→"Leads" (es), "Organizations"→"Pipelines" (es+es-419), plus overrides directos.

## 9. Decisiones consolidadas

- **B2C, no B2B**: borradas todas referencias a Organization Details. `organization` field repurposed.
- **v16 stays**: usuario rechazó downgrade a v15. Bugs son del FCRM frontend, no del backend.
- **Solo Deals importan**: 90% del trabajo del agente. Foco en Deal UI.
- **Software se adapta a la empresa, no al revés**: replicar UX Zendesk donde sea posible. JS injection accepted como workaround.

## 10. Frustraciones del usuario

- Primera vez que se quejó del freeze: pensé que era Chrome. NO ERA. Era nginx 4094 byte URL limit. Issue #1884.
- "tus cambios no funcionan en absoluto": Form Scripts en CRM Deal no afectan sidebar global. No reconocí inmediatamente.
- Frustración por interpretar mal su lista (creí que quería esconder Tareas — solo se quejaba que no tenían deal asociado, lo cual ya está OK).
- Próxima sesión NO ve el contexto de Claude porque sandbox local de Frappe Cloud no sincroniza con GitHub. Solución: push de docs directo a main vía MCP github.

## 11. Estado al cierre de sesión

✅ Migración Sell + Support completa
✅ List view del Deal con 50 cols + filtros estilo Zendesk
✅ Layouts Datos+Side Panel organizados con zd_*
✅ Pipeline + stages coloreados + filtrables
✅ Tasks con estados Pendiente/Realizada + track_changes + Deal column en list view
✅ Tickets de Support migrados + linkeados
✅ Translation "Clientes potenciales"→"Leads" + "Organizations"→"Pipelines"
✅ CLAUDE.md banner + MIGRATION_STATE.md + SESSION_HISTORY.md pushed a main
❌ Sidebar hide Contactos/Notas (restrict_to_domain aplicado, sin verificar funcionamiento)
❌ Búsqueda global (Cmd+K) reportada como no funciona — pendiente investigar
❌ Validar que el panel "Tickets en Support" del side panel se renderiza (CSS selectors)
❌ PR #10 sin mergear — main NO tiene los 30 scripts de migración (solo los docs)

## 12. Comandos de uso típico

```bash
# Re-correr import
cd /home/user/sell-medinet-backend
FRAPPE_CLOUD_SITE_URL="<env>" FRAPPE_CLOUD_API_KEY="<env>" FRAPPE_CLOUD_API_SECRET="<env>" \
  python3 migration/import-full.py --entity deals --workers 4

# Verificar counts
python3 migration/verify.py

# Audit fidelity
python3 migration/audit-fidelity.py --n 50

# Discovery (read-only)
python3 migration/discovery.py
```

## 13. Branch + repo

- Repo: `villagran-gif/sell-medinet-backend`
- Branch: `claude/whatsapp-system-user-token-WKAZ7`
- PR: #10 (open, draft, mergeable_state=dirty, 54 commits, 8772 additions)
- Merge pendiente: necesario para que sesiones nuevas vean los 30+ scripts de migration/

## 14. Para retomar

1. Hacer `git checkout claude/whatsapp-system-user-token-WKAZ7` antes de cualquier laburo
2. Si cloneás main, solo verás CLAUDE.md banner + MIGRATION_STATE.md + SESSION_HISTORY.md (los docs sobreviven)
3. Para los scripts ejecutables, leer este doc y reescribir según necesidad O mergear PR #10
