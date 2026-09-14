# Confirmación de asistencia a citas existentes

Diagnóstico de septiembre de 2026. No es el consentimiento para crear reservas.

## Estado verificado

El gateway desplegado a838ae6 tiene `confirmations` deshabilitado en su log de arranque. El dispatcher sólo admite Antonia, incluso si una configuración menciona otro handler. La base histórica no contiene citas futuras; la última incorporación es de mayo. No activar `/confirmations/tick` ni restaurar el consumidor antes de resolver las brechas descritas abajo.

## Recorrido existente

- `clinyco_AI/scripts/melania-ingest.mjs`: script previsto para VPS chileno. Consulta `all-appointments` mediante JWT, normaliza por ID externo y publica al intake del gateway. La existencia del script no comprueba que su cron esté instalado o activo. El offset predeterminado es fijo (-04:00), y el filtro excluye cancelaciones; ambas cosas requieren revisión antes de reactivar.
- `routes/intake.js` y `lifecycle.js`: upsert por `external_id`. Actualiza fecha/estado importado pero conserva estado local y marcas de envío incluso tras cambios de cita.
- `scheduler.js`: invocación externa de tick; primer mensaje para citas futuras pendientes; recordatorio predeterminado T-76h, ventana 74–78h. Ambas pasadas corren seguidas. Puede enviar solicitud y recordatorio en el mismo tick.
- `outbound_messages`: registra plantilla, ID aceptado por Chatwoot y dry-run. El UNIQUE se aplica después del envío, por lo que no garantiza evitar dos efectos concurrentes. Una simulación también ocupa el índice de éxito y avanza el estado local.
- `findAppointmentByInboundPhone`: busca por teléfono exacto, admite hasta 24h después de la cita y elige la primera de varias. No usa conversación, respuesta citada, mensaje de solicitud ni revisión vigente de la cita; no excluye el estado Medinet cancelado/reagendado.
- `handleInboundEvent`: clasifica, registra clasificación y actualiza PostgreSQL. No escribe Medinet. El handoff de cambio apunta a `/melania/start-from-confirmation`, que no aparece implementado en el core inspeccionado. No se verificó una ruta alternativa.
- `updateAppointmentState` existe en el cliente Medinet del core, pero no está conectado a este flujo. Su existencia no demuestra permisos ni éxito de Confirm/Cancel.
- `no_response` está declarado, sin transición automática localizada. Una falta de respuesta no prueba inasistencia.

## Caso real auditado de extremo a extremo

Se contrastaron solicitud, recordatorio y respuesta visibles en Chatwoot con IDs de mensajes y eventos persistidos. La solicitud y el recordatorio fueron aceptados con unos 2,24 segundos de diferencia. Hay un comprobante `read` del recordatorio enlazado a su mismo ID de mensaje. El paciente respondió explícitamente que confirmaba la hora. El registro local pasó a `confirmed`; el estado Medinet importado conservó `Agendado`. No hay un comprobante de escritura y relectura en Medinet. La ausencia de relectura no permite afirmar el estado actual de esa cita en Medinet. No se observó acuse posterior en el hilo.

El caso histórico usó Haiku según su registro. No se atribuye esa clasificación al clasificador determinista actual. Los identificadores privados y la cronología completa se conservan fuera del repositorio público.

## Corrección acotada

Este PR no reactiva el módulo ni cambia la agenda. Corrige la interpretación local de negaciones, preguntas y peticiones de mover la hora. Los acuses distinguen respuesta registrada de cambio efectivo de agenda. El procesador no envía acuse ni handoff si la actualización local no devuelve una fila. Una excepción de escritura también detiene el acuse.

Los nombres heredados `confirmed` y `cancelled` siguen siendo estados locales; no se migran datos históricos ni se presentan como recibos de Medinet. Se exige que el estado devuelto corresponda al acuse. No se afirma actualización de Medinet aunque su estado importado diga Confirmado.

## Casos comprobados y pendientes

| Caso | Resultado de esta revisión |
|---|---|
| Sí / confirmo / ahí estaré | Clasificación local comprobada; asociación inequívoca y escritura Medinet pendientes |
| No puedo / cancelo | No puedo queda ambiguo (cancelar o cambiar); cancelo es petición de cancelación, nunca prueba de ejecución |
| ¿Puede ser más tarde? | Se corrige de other a reschedule; no cambia la cita original |
| Dirección / precio / ¿Confirmo por aquí? | Pregunta sin aceptación; el consumidor histórico no responde información por sí mismo |
| Varias citas | La selección actual LIMIT 1 es insuficiente; requiere asociación verificable o aclaración |
| Respuesta tardía/cita cancelada/reagendada | Filtro actual inseguro; requiere fecha futura y revisión actual de agenda |
| Duplicados | Control por evento del dispatcher preservado; deduplicación por mensaje y reserva del envío antes del efecto pendientes |
| Pausa humana | El módulo está fuera de ruta; sus envíos no consultan el control persistente. Integrarlo es requisito previo a reactivar |
| Fallo de escritura | Pruebas de cero filas/excepción: no hay acuse de éxito; no se prueba escritura Medinet |

Pruebas sintéticas del clasificador, constructor de acuse y procesador real con dependencias sustituidas; regresiones del dispatcher. Sin llamadas de IA, mensajes a pacientes, POST a Medinet ni despliegue. La corrección no equivale a restaurar el flujo completo.

## Main WhatsApp preparation — 2026-09-14

User chose the main Clinyco number +56 9 5338 6191 (Chatwoot inbox
110652). The historical client inherited CHATWOOT_INBOX_ID and trusted
stored conversation IDs, allowing reminders/acknowledgments in the retired
inbox 107690. The client now pins the main inbox, verifies its live
phone_number and Channel::Whatsapp type, and verifies an existing
conversation's inbox before sending. A failed/missing/mismatched read aborts
before POST. The inbox label alone is not proof of its sending number.

Live sending additionally requires CONFIRMATIONS_LIVE_SEND_ENABLED=true;
the default remains dry-run even if CHATWOOT_DRY_RUN=false is inherited.
No production configuration was changed. Do not enable either live sending
or the confirmations module yet. This is channel isolation, not completion
of the attendance flow. It does not merge old conversation history or
implement existing-thread reuse, appointment/reply correlation, human-pause
integration, concurrent scheduler claims, or verified Medinet updates.
Those remain prerequisites before activation, as described above.

Validation: 40 local Node tests pass, including synthetic HTTP checks for
the main channel, legacy inbox override, wrong/missing phone, wrong channel
type, old conversation, failed reads, and default no-HTTP dry-run. These
prove client guards, not WhatsApp delivery or real model behavior. No
patient was contacted and no appointment state was modified.

API contracts consulted:
- https://developers.chatwoot.com/api-reference/inboxes/get-an-inbox
- https://developers.chatwoot.com/api-reference/conversations/conversation-details

## Reply correlation — follow-up in #39

Removed the phone-only earliest-appointment lookup and its 24-hour grace
period after the appointment. Only explicit Chatwoot in_reply_to references
are eligible in this first stage, matched to the recorded real outbound
message, account 162472, inbox 110652, conversation, phone, and appointment
revision. Multiple matches, legacy sends without context, dry-run sends,
past appointments and imported inactive/unknown Medinet states do not match.
An intake change in date, branch, professional, specialty, patient or
Medinet state increments the revision via migration 003; an old reply cannot
be applied to that new revision. State transitions also compare the revision
and require a pending future appointment, so a concurrent state transition
returns no receipt. Source snapshot freshness is still not a live Medinet check.

A bare unquoted yes is deliberately NOT handled yet: pending-question
coordination with Antonia must be implemented before enabling this module.
The existing dispatcher remains unchanged. Human control, outbound concurrency,
source refresh, and Medinet receipt integration still block activation.

53 local tests pass. New tests use synthetic webhook payloads and mocked DB
results; they do NOT execute PostgreSQL or prove the SQL migration/trigger.
Additionally, sql-context-check.mjs passed against isolated PostgreSQL/WASM
(PGlite): migrations including 003 repeated, exact selection among two appointments,
wrong conversation, reprogrammed revision, repeated transition, cancelled and past
appointments. Concurrent multi-connection behavior remains untested. No migration
was run on production.
