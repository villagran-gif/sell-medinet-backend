# Confirmaciones por WhatsApp dedicado

Cuenta Chatwoot 162472, inbox 107690, +56962718765. No cambia el inbox principal de Antonia.

## Estado y activación

- `ATTENDANCE_ENABLED=true`: activa router/consumidor y revisión de trabajos cada 30 segundos.
- `ATTENDANCE_MODE=test` (default): solo conversación 399; no permite envíos de citas reales.
- `ATTENDANCE_MODE=live`: habilita el consumidor del inbox dedicado y envíos de los IDs expresamente incluidos en un lote.
- `ATTENDANCE_LIVE_SEND_ENABLED=true`: permite enviar WhatsApp, incluidos mensajes de prueba. No activa lotes por sí sola.
- `ATTENDANCE_MEDINET_WRITE_ENABLED=true`: habilita Confirm/Cancel; dejar desactivado hasta verificar conexión y lectura de identidad con Medinet.
- `ATTENDANCE_TRIAL_ID=trial-<identificador estable>`: envía una única prueba a +56987297033 en #399 al arrancar. El mismo identificador no reenvía tras un reinicio. No modifica Medinet.
- Reutiliza `CHATWOOT_API_TOKEN`, `CHATWOOT_DATABASE_URL`/`DATABASE_URL` y `CONFIRMATIONS_INTAKE_TOKEN`. Medinet requiere las credenciales existentes MEDINET_USER/KEY o MEDINET_JWT_USERNAME/PASSWORD o MEDINET_API_TOKEN.

El módulo histórico `/confirmations` debe permanecer deshabilitado. Este módulo tiene schema independiente `attendance`, no adopta instrucciones ni estados históricos.

## Procesamiento

Cada mensaje entrante tiene un registro único y cada conversación se procesa bajo bloqueo PostgreSQL. Los eventos con más de diez minutos se conservan sin ejecutar. Los eventos del inbox dedicado se reclaman en orden por conversación. Un envío se reserva antes del HTTP; los resultados inciertos no se reintentan automáticamente.

Una respuesta citada se asocia al mensaje saliente registrado. Una respuesta sin cita requiere una sola solicitud vigente para el teléfono/conversación. También se consideran solicitudes respondidas, evitando que un segundo «sí» se atribuya a otra cita. Cambios de intención, preguntas y múltiples citas pasan a atención humana.

Confirmar/cancelar exige leer nuevamente la cita, comparar ID de paciente, teléfono, profesional, sede, día, hora y tipo; después se escribe y se vuelve a leer. Solo un resultado coincidente produce un mensaje de éxito. Un timeout deja estado `uncertain` y pausa humana. Reagendar conserva la cita original y abre gestión humana; este módulo no elige otra hora.

Una respuesta de un agente humano pausa de forma persistente. También respeta `attendance_paused` en atributos de Chatwoot y estado snoozed. La pausa se aplica a este consumidor dedicado; no sustituye al control interno de Antonia. El inbox principal conserva su ruteo actual.

## Cola de atención

Los envíos quedan pending con etiqueta `confirmacion_automatica`. Los acuses confirmados/cancelados quedan resolved. Preguntas, cambios y errores quedan open y con nota privada para el responsable existente. No cambia permisos ni asignaciones; los agentes con acceso al inbox pueden consultar el historial.

El cliente comprueba o crea la etiqueta antes de enviar el piloto. No asumir que pending oculta el historial a agentes.

## API protegida

Todos los endpoints exigen `Authorization: Bearer <CONFIRMATIONS_INTAKE_TOKEN>`:

- GET `/attendance/health`: configuración booleana.
- POST `/attendance/trial`: `{idempotencyKey:"trial-identificador-unico"}`.
- POST `/attendance/batch`: `{appointmentIds:[...],professionalId:123,sendAt:"ISO con offset",commit:false}`. Primero devuelve el catastro leído de Medinet. `commit:true` reserva el lote en una transacción. Solo IDs exactos y un profesional; máximo 20. Excluye canceladas, reagendadas, bloqueos, pruebas, identidad incompleta y citas pasadas. El horario debe ser futuro y anterior a cada cita.
- POST `/attendance/tick`: ejecuta trabajos vencidos; el timer también lo hace.
- GET `/attendance/review`: estado de solicitudes y trabajos, sin exponer ficha clínica.
- POST `/attendance/pause` o `/resume`: `{conversationId:399}`. Resume no repite mensajes ni borra decisiones.

## Validación

`npm test` ejecuta tests unitarios y regresiones. `ATTENDANCE_TEST_DATABASE_URL=... node attendance/integration-check.mjs` prueba SQL y handlers en una DB aislada. CI crea PostgreSQL 16 efímero. Alternativa local: `PGLITE_MODULE=<ruta absoluta> node attendance/integration-check.mjs`, sin verificar bloqueos nativos.

No configurar ATTENDANCE_TEST_DATABASE_URL con una base de producción: el script trunca exclusivamente las tablas del schema attendance de la base de pruebas.

## Límites que requieren verificación en vivo

Validar shape real del detalle Medinet y credenciales del gateway antes de activar escrituras. Lectura/escritura/lectura no constituye una transacción distribuida: una edición concurrente de Medinet puede ocurrir entre llamadas; los desacuerdos se escalan y nunca se presentan como éxito. La aceptación HTTP de Chatwoot no acredita entrega en WhatsApp. El piloto requiere evidencia de recepción y retorno.

Rollback: ATTENDANCE_ENABLED=false y ATTENDANCE_LIVE_SEND_ENABLED=false. No borrar tablas ni reejecutar trabajos inciertos.
