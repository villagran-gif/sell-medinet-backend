# twilio-voice

Bridge de telefonía de voz: **Twilio Voice → Chatwoot**. Reemplaza
**Zendesk Talk** (invoice `INV13629711`, "Talk Usage Subscription", UOM
*Voice*), que el plan de migración (`docs/migration-chatwoot-frappe.md`) no
cubría.

## Qué hace

Cuando entra una llamada al número Twilio:

1. **Desvía la llamada a un número de agente** (`TWILIO_VOICE_FORWARD_TO`).
2. Si el agente **no contesta** (no-answer / busy / failed) → reproduce un
   saludo y **graba buzón de voz**.
3. Cada paso se **registra en Chatwoot** como una conversación (llamada
   entrante → atendida/perdida → buzón con link a la grabación).
4. Todos los webhooks crudos quedan en `twilio_voice.raw_events`
   (durabilidad + replay + auditoría), y el estado consolidado por llamada
   en `twilio_voice.calls`.

Si no se configura `TWILIO_VOICE_FORWARD_TO`, opera en **modo solo-buzón**.

> Chatwoot **no atiende llamadas PSTN nativamente**. Twilio maneja la voz
> real; este bridge deja el registro de cada llamada en Chatwoot vía un inbox
> tipo **API channel** (mismo mecanismo que `tiktok-bridge`). El agente
> conversa por teléfono y ve el historial/buzón en Chatwoot.

## Montaje

Opt-in con `TWILIO_VOICE_ENABLED=true`. En `server.js`:

```js
if (process.env.TWILIO_VOICE_ENABLED === "true") {
  app.use("/twilio-voice", createTwilioVoiceRouter({
    autoMigrate: process.env.TWILIO_VOICE_AUTO_MIGRATE !== "false",
  }));
}
```

Mientras el flag esté apagado el módulo no toca DB ni corre migraciones.

## Variables de entorno

| Var | Requerida | Default | Descripción |
|---|---|---|---|
| `TWILIO_VOICE_ENABLED` | sí | `false` | Activa el módulo |
| `TWILIO_AUTH_TOKEN` | sí | — | Auth Token de Twilio. Valida `X-Twilio-Signature` y autentica el proxy de grabaciones |
| `TWILIO_ACCOUNT_SID` | para grabaciones | — | Account SID. Necesario solo para el proxy `/recording/:callSid` |
| `TWILIO_VALIDATE_SIGNATURE` | no | `true` | `false` desactiva validación de firma (solo debugging inicial) |
| `TWILIO_VOICE_PUBLIC_BASE_URL` | recomendada | (derivada de headers) | Base pública, ej `https://sell-medinet-backend.onrender.com`. Necesaria para que la firma valide detrás del proxy de Render |
| `TWILIO_VOICE_FORWARD_TO` | no | — | Número del agente en E.164 (ej `+569XXXXXXXX`). Vacío → modo solo-buzón |
| `TWILIO_VOICE_CALLER_ID` | no | (el número Twilio) | CallerID que ve el agente al recibir el desvío |
| `TWILIO_VOICE_DIAL_TIMEOUT` | no | `20` | Segundos de timbrado antes de pasar a buzón |
| `TWILIO_VOICE_LANGUAGE` | no | `es-MX` | Idioma del `<Say>` (voz TTS de Twilio; `es-CL` no existe en Polly) |
| `TWILIO_VOICE_VOICEMAIL_PROMPT` | no | (texto ES) | Saludo antes de grabar el buzón |
| `TWILIO_VOICE_VOICEMAIL_MAXLEN` | no | `120` | Largo máximo del buzón (segundos) |
| `TWILIO_VOICE_GOODBYE` | no | (texto ES) | Despedida tras grabar el buzón |
| `TWILIO_VOICE_CHATWOOT_ENABLED` | no | `true` | Registrar llamadas en Chatwoot |
| `CHATWOOT_BASE_URL` | no | `https://app.chatwoot.com` | Base de Chatwoot |
| `CHATWOOT_VOICE_INBOX_IDENTIFIER` | para Chatwoot | — | `identifier` del inbox API de voz. Si falta, el registro en Chatwoot queda apagado |
| `TWILIO_VOICE_DATABASE_URL` | no | (cae a `DATABASE_URL`) | Conexión Postgres |

## Endpoints

Todos `application/x-www-form-urlencoded` (lo que manda Twilio), salvo health
y el proxy de grabación.

| Método | Ruta | Para qué |
|---|---|---|
| `GET`  | `/twilio-voice/health` | Liveness + estado DB/config |
| `POST` | `/twilio-voice/incoming` | **Voice webhook del número** (TwiML inicial) |
| `POST` | `/twilio-voice/dial-status` | `action` del `<Dial>`: decide buzón vs fin |
| `POST` | `/twilio-voice/voicemail` | `action` del `<Record>`: persiste la grabación |
| `POST` | `/twilio-voice/status` | (opcional) `statusCallback` de la llamada |
| `GET`  | `/twilio-voice/recording/:callSid` | Proxy autenticado de la grabación |

## Flujo de llamada

```
Llamada → /incoming ──┬─(forward)→ <Dial agente> → /dial-status ──┬─ atendida → <Hangup>
                      │                                            └─ no contesta → buzón
                      └─(sin agente)→ buzón
buzón → <Record> → /voicemail → Chatwoot (link a grabación) → <Hangup>
```

## Configuración del lado de Twilio

1. **Conseguir el número** (opción elegida: número nuevo Twilio):
   Console → Phone Numbers → Buy a number. Para Chile (`+56`) Twilio puede
   pedir un *Regulatory Bundle* (dirección + documento). Alternativa
   inmediata: número de otro país o toll-free mientras se resuelve.
   *(La portación del número de Zendesk Talk es un trámite aparte —
   port-in con LOA; el invoice sirve de comprobante de titularidad. Se puede
   hacer después sin tocar este código.)*
2. **Configurar el webhook de voz** del número:
   - "A CALL COMES IN" → Webhook → `https://<base>/twilio-voice/incoming` → **HTTP POST**.
   - (Opcional) "CALL STATUS CHANGES" → `https://<base>/twilio-voice/status` → POST.
3. **Setear env vars** en Render: `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID`,
   `TWILIO_VOICE_PUBLIC_BASE_URL`, `TWILIO_VOICE_FORWARD_TO`, `TWILIO_VOICE_ENABLED=true`.

## Configuración del lado de Chatwoot

1. Settings → Inboxes → Add Inbox → **API**.
2. Copiar el **inbox identifier** y setear `CHATWOOT_VOICE_INBOX_IDENTIFIER`.
3. (Opcional) Asignar agentes a ese inbox para que vean las llamadas/buzones.

## Seguridad

- Firma `X-Twilio-Signature` validada por defecto (HMAC-SHA1 sobre URL+params
  con el Auth Token). Si falla → `403` + Hangup.
- Sin firma válida no se procesa nada; para el primer test se puede usar
  `TWILIO_VALIDATE_SIGNATURE=false` temporalmente.
- Secretos solo en env vars de Render (nunca en el repo).
- El proxy de grabación usa el `CallSid` (34 chars aleatorios) como
  capability token; las grabaciones no quedan públicas en Twilio.

## Cutover Zendesk Talk

1. Validar end-to-end con el número Twilio (llamada → desvío → buzón → Chatwoot).
2. Apuntar la difusión del número (web, Google Business, etc.) o portar el
   número de Zendesk a Twilio.
3. Cancelar la subscription **Zendesk Talk** (`INV13629711`).

## Roadmap

- [x] Desvío a agente + fallback a buzón + registro en Chatwoot.
- [ ] IVR/menú de opciones (ventas/soporte) antes del desvío.
- [ ] Transcripción del buzón (Twilio o Whisper) como texto en Chatwoot.
- [ ] Grabación de llamadas atendidas (dual-channel) además del buzón.
- [ ] Métricas: llamadas/día, % atendidas, tiempo a respuesta.
