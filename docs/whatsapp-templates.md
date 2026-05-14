# HSM templates de WhatsApp — MelanIA

Catálogo canónico de las plantillas que el módulo `confirmations/`
envía vía Chatwoot Cloud. Para que funcionen en producción **deben
estar aprobadas en Meta Business Manager** y registradas con el
nombre exacto que aparece abajo.

Mientras una plantilla no esté aprobada, el módulo opera en
`CHATWOOT_DRY_RUN=true` (default) y no envía mensajes reales.

## Convenciones

- **Idioma**: `es` (español).
- **Categoría**: `UTILITY` (todas son recordatorios/confirmaciones
  transaccionales de citas — no marketing).
- **Nombre**: `cly_<intencion>_<modifier>_v<n>`. Versión con sufijo
  porque Meta no permite editar el texto de una plantilla aprobada
  sin re-aprobar; cuando cambie el copy, se registra `_v2` y se
  actualiza `confirmations/templates.js`.
- **Variables**: posicionales `{{1}}`, `{{2}}`, ... — el orden
  importa. Los `processed_params` los arma `templates.js` con esa
  numeración.

## Pendiente de registrar en Meta BM

### `cly_confirm_appointment_v1`

Primer mensaje al paciente apenas la cita aparece en Medinet.
Trigger: `confirmations/intake` → `lifecycle.sendFirstMessage()`.

**Body:**

```
Hola {{1}}, soy MelanIA de Clínyco 👋. Te confirmamos tu cita de {{2}} con {{3}} el {{4}} a las {{5}}. ¿La tomas? Responde SÍ para confirmar, NO para cancelar, o REAGENDAR si quieres cambiarla.
```

| # | Significado | Ejemplo |
|---|---|---|
| 1 | Nombre corto del paciente | `Juan` |
| 2 | Especialidad | `Medicina General` |
| 3 | Profesional | `Dra. Foo Bar` |
| 4 | Fecha en formato DD/MM/YYYY (TZ Santiago) | `11/05/2026` |
| 5 | Hora HH:MM 24h (TZ Santiago) | `17:30` |

### `cly_confirm_reminder_76h_v1`

Recordatorio enviado ~76 horas antes de la cita.
Trigger: `confirmations/scheduler` → `lifecycle.sendReminder()`.

**Body:**

```
Hola {{1}}, te recordamos tu cita de {{2}} con {{3}} el {{4}} a las {{5}}. Si necesitas reagendar o cancelar, respóndenos por aquí. ¡Te esperamos!
```

Mismas variables que `cly_confirm_appointment_v1`.

Es **informativo**: no re-pide confirmación. Regla de lifecycle: sin
respuesta al recordatorio = la cita sigue confirmada (no es fallo).

> **Nota 2026-05-13**: en Meta BM existen `_v1` y `_v2` (duplicado, texto
> idéntico). Decisión: usar `_v1`. La constante en `templates.js` apunta a
> `_v1` por default y es overridable con `CHATWOOT_HSM_CONFIRM_REMINDER`.
> La `_v2` queda inactiva, no se referencia.

## Cómo registrar

1. Meta Business Manager → WhatsApp Manager → cuenta WABA de Clínyco.
2. **Templates** → **New**.
3. Categoría `UTILITY`, idioma `es`.
4. Pegar el body tal cual (con `{{1}}`, etc.).
5. Dar nombre exacto (`cly_confirm_appointment_v1` o
   `cly_confirm_reminder_76h_v1`).
6. Submit → esperar aprobación (suele ser <24h para UTILITY).

Una vez aprobadas, configurar en Render del backend:

```
CHATWOOT_DRY_RUN=false
CHATWOOT_API_TOKEN=<token de la cuenta 162472>
CHATWOOT_INBOX_ID=<id del inbox WhatsApp en Chatwoot Cloud>
```

## Cambios de copy

Si cambia el texto de una plantilla aprobada:

1. Registrar nueva versión `_v2` en Meta BM (la `_v1` queda viva
   hasta que termine su uso).
2. Cambiar la constante en `confirmations/templates.js` a `_v2`.
3. Esperar despliegue.
4. (Opcional) Pedir a Meta archivar la `_v1` una vez que no haya
   tráfico contra ella.
