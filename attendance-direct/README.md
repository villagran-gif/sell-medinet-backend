# Confirmaciones directas: Meta → gateway → SELL

Sustituye el transporte Chatwoot del número 56962718765 (phone ID 1107398659118949). No modifica ni elimina el historial existente. Todo queda desactivado por defecto. No hay escaneo ni envío masivo; `/send` acepta una sola cita, previa vista con fingerprint. El modo de prueba sólo acepta 56987297033 y no escribe en Medinet.

## Configuración y puesta en marcha

1. Desplegar este código desactivado y el panel complementario en clinyco_AI. Configurar por canal seguro `ATTENDANCE_META_TOKEN`, `ATTENDANCE_META_APP_SECRET`, `ATTENDANCE_META_VERIFY_TOKEN` y `ATTENDANCE_META_VERSION` (versión Graph verificada con la cuenta). No copiar credenciales a commits ni al navegador del dashboard.
2. `ATTENDANCE_DIRECT_ENABLED=true` permite verificar el callback y guardar eventos firmados. Mantener `ATTENDANCE_DIRECT_SEND_ENABLED=false`, `ATTENDANCE_DIRECT_MODE=test`, `ATTENDANCE_DIRECT_CUTOVER_VERIFIED=false`. El callback es `/attendance-direct/webhook`, GET handshake / POST HMAC SHA256 sobre cuerpo crudo. Sólo recibe el phone ID indicado.
3. Verificar en Meta las apps suscritas y la configuración del webhook de ESTE número. Configurar la entrega directa a este callback sin cambiar el número principal 56953386191. Un override puede ser específico de la app: no suponer que elimina otras suscripciones. Confirmar con un evento real al número de pruebas que no aparece una nueva conversación en Chatwoot. Si hay duplicación, no activar envíos.
4. Desactivar `ATTENDANCE_ENABLED` y conservar `CONFIRMATIONS_ENABLED=false` antes de activar envíos directos. Retirar la conexión de Chatwoot sólo después de verificar destino y recepción, preservando historial y configuración anterior para reversión. El código no cambia suscripciones ni elimina inboxes.
5. Una vez verificada la separación, `ATTENDANCE_DIRECT_CUTOVER_VERIFIED=true` y `ATTENDANCE_DIRECT_SEND_ENABLED=true`. POST `/attendance-direct/trial` con `{key:"trial-unico-...",date:"YYYY-MM-DD",actor:"operador"}`. La fecha debe ser futura. Comprobar aceptación, entrega, respuesta, registro en SELL y cero escritura Medinet. No reenviar al reiniciar.
6. Antes de modo real: probar concurrencia con PostgreSQL real, shape y permisos de lectura/escritura Medinet, y rollback. `ATTENDANCE_DIRECT_MODE=live` permite otros pacientes; `ATTENDANCE_MEDINET_WRITE_ENABLED=true` permite las escrituras reutilizando el cliente validado. No declarar una cita confirmada si no hay relectura coincidente.

## API protegida

Bearer `CONFIRMATIONS_INTAKE_TOKEN` para `/attendance-direct/review?date=YYYY-MM-DD`, `/trial`, `/send`. SELL usa un proxy autenticado en el core; configurar el mismo token allí. El navegador nunca recibe ese token ni el de Meta.

`POST /send {appointmentId:123}` devuelve vista previa sin enviar. Luego `{appointmentId:123,commit:true,fingerprint:"...",actor:"..."}`. No acepta teléfonos alternativos. No envía citas vencidas ni registros administrativos/pruebas en modo real.

## Estados y límites

- IDs de Meta tipo texto; tablas aisladas en `attendance_direct`. HMAC inválido → 403; DB caída → 503 para reintento del proveedor. Webhook sólo persiste, no ejecuta efectos externos.
- Worker ordena eventos, deduplica y serializa bajo advisory lock. Antiguos (>10 min) se registran sin ejecutar. Una respuesta sin cita única o contradictoria produce pausa persistente y enlace al soporte.
- Envíos se reservan antes del HTTP. Timeout/crash queda `uncertain`/`needs_review`; nunca reintentar ciegamente. Una pausa o incertidumbre necesita revisión operativa; no hay botón que la levante automáticamente.
- Entrega (`accepted/sent/delivered/read`) es distinta del estado Medinet. La confirmación exige identidad actual → escritura → relectura. El panel conserva también respuestas pausadas y errores.
- Solicitudes de ayuda/reagendar reciben `https://wa.me/56953386191?text=Necesito%20ayuda%20con%20mi%20cita`. El paciente debe abrirlo y enviar: NO se afirma transferencia automática al equipo.
- Una nueva solicitud al mismo teléfono se bloquea mientras exista otra vigente, incluidas las ya respondidas (48 h). Es deliberado para evitar que otro «sí» alcance una segunda cita. Cadencias múltiples y recuperación manual quedan fuera de esta entrega.
- Clasificación local reutilizada, sin llamada al modelo ni coste de IA. No hay llamadas a APIs de Chatwoot en este flujo; sólo se reutilizan las funciones de Medinet del cliente existente.

## Rollback

Detener envíos directos primero, conservar tablas/eventos/claims y revisar efectos inciertos. Restaurar callback/suscripción anterior sólo si se opta por volver a Chatwoot; no ejecutar ambos transportes a la vez. No borrar registros ni reproducir mensajes pendientes tras el cambio.

## Validación

`npm test`: incluye HMAC, phone ID, restricciones de envío, correspondencia de respuestas, plantilla de prueba y pruebas SQL con PGlite (PostgreSQL embebido). La prueba embebida sustituye advisory locks: NO acredita concurrencia multiinstancia real. La prueba real Meta + PostgreSQL y sesión del equipo permanece como requisito antes de activar.
