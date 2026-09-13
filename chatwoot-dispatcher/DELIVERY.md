# Entrega a Antonia

Una reserva mantiene `processed_at` vacío y asigna `dispatch_state=processing`. Solo una respuesta HTTP exitosa con JSON `ok: true` del core permite marcar `delivered` y completar `processed_at`. Los rechazos deliberados del core (por ejemplo, mensaje no entrante) también confirman la recepción.

Fallos de configuración, carga de handler, conexión, timeout o respuesta del core quedan como `needs_review` con el error, sin marcar el evento procesado. Cada dispatcher reserva un evento por vez, de forma atómica con `FOR UPDATE SKIP LOCKED`.

Un timeout puede ocurrir después de que el core haya contestado o iniciado una operación de Medinet. Por ese motivo, estos eventos no se reenvían automáticamente. Las reservas interrumpidas por más de 30 minutos se identifican para revisión. Revisar la conversación y la idempotencia del core antes de recuperar eventos; los errores históricos tampoco se reproducen automáticamente.

Las tres columnas de auditoría se agregan de forma idempotente al primer uso. No se borran datos ni se modifican los contratos de Medinet, Twilio o del webhook.

Verificación: `npm test` incluye fallos, reserva en curso, concurrencia y confirmación del JSON del core. Las pruebas usan eventos sintéticos y no envían mensajes externos.
