# RUNBOOK — MelanIA (módulo `confirmations`)

Operación y troubleshooting del sistema de confirmaciones de citas por
WhatsApp. Para el diseño y arquitectura ver `confirmations/README.md`.

---

## Arquitectura en 30 segundos

```
Medinet (citas)
   │  cron cada 15min: scripts/melania-ingest.mjs (en VPS chileno)
   ▼
POST /confirmations/intake  ──►  confirmations.appointments (state=scheduled)
   │  cron cada 10min: POST /confirmations/tick
   ▼
chatwoot-client → Chatwoot Cloud → Meta WhatsApp → paciente recibe HSM
   │
   ▼  paciente responde
Chatwoot webhook → POST /chatwoot-webhook/events → chatwoot.raw_events
   │  auto-trigger inline (+ cron cada 5min de respaldo)
   ▼
inbound-processor → classifier Haiku 4.5 → applyIntent → sendAcknowledgment
   │
   ▼  ack al paciente (texto libre, ventana 24h) + state machine actualizado
```

Dos repos:
- **`sell-medinet-backend`** (Render): módulo `confirmations/`, recibe intake,
  manda HSM, procesa respuestas. NO habla con Medinet (geo-block).
- **`clinyco_AI`** (VPS chileno `69.6.226.132`): `scripts/melania-ingest.mjs`
  poolea Medinet y empuja al intake. Tiene acceso geo a Medinet.

---

## Acceso

```bash
# VPS chileno (donde corre el cron + ingest)
ssh -p 22022 root@69.6.226.132
cd /root/clinyco_AI && set -a; . .env; set +a   # carga DATABASE_URL, tokens, etc.

# Backend en Render
# service: srv-d68hpvoboq4c73d368k0
# URL: https://sell-medinet-backend.onrender.com
# Deploys son MANUALES (auto-deploy apagado).
```

`$TOKEN` para los endpoints = valor de `CONFIRMATIONS_INTAKE_TOKEN` (en Render
env y en el `.env` del VPS como `SELL_MEDINET_INTAKE_TOKEN`).

---

## Health check (1 comando)

```bash
/root/melania-health.sh
```

Si no existe, crearlo:

```bash
cat > /root/melania-health.sh <<'EOF'
#!/usr/bin/env bash
cd /root/clinyco_AI && set -a; . .env; set +a
echo "=== Cron ==="; systemctl is-active cron
echo "=== Backend ==="; curl -s https://sell-medinet-backend.onrender.com/confirmations/health; echo
echo "=== Webhook ==="; curl -s https://sell-medinet-backend.onrender.com/chatwoot-webhook/health; echo
echo "=== Errores envío (ojalá vacío) ==="
psql "$DATABASE_URL" -c "SELECT sent_at, template_name, error FROM confirmations.outbound_messages WHERE error IS NOT NULL ORDER BY sent_at DESC LIMIT 5;"
echo "=== Estados ==="
psql "$DATABASE_URL" -c "SELECT state, COUNT(*) FROM confirmations.appointments GROUP BY state ORDER BY COUNT(*) DESC;"
echo "=== Respuestas pacientes (24h) ==="
psql "$DATABASE_URL" -c "SELECT decided_at, intent, raw_message FROM confirmations.inbound_classifications WHERE decided_at > now() - interval '24 hours' ORDER BY decided_at DESC LIMIT 10;"
EOF
chmod +x /root/melania-health.sh
```

**Verde** = cron `active`, backend `db:ok`, webhook `db:ok`, 0 errores de envío.

---

## Monitoreo de logs

Los logs de tick/process escriben JSON en una sola línea (sin newline). Para leerlos:

```bash
tr '}' '}\n' < /var/log/melania-tick.log    | tail -10   # scheduler
tr '}' '}\n' < /var/log/melania-process.log | tail -10   # inbound processor
tail -20 /var/log/melania-ingest.log                     # ingest (ya tiene newlines)
```

Cron del sistema:
```bash
grep CRON /var/log/syslog | grep melania | tail -10
```

---

## Crontab (en el VPS)

```cron
# Ingest: detecta citas nuevas/cambiadas en Medinet, empuja al intake
*/15 * * * * cd /root/clinyco_AI && set -a && . .env && set +a && /usr/bin/node scripts/melania-ingest.mjs --days 7 >> /var/log/melania-ingest.log 2>&1

# Scheduler: 1er mensajes + recordatorios T-76h
*/10 * * * * curl -sS -X POST -H "Authorization: Bearer $TOKEN" "https://sell-medinet-backend.onrender.com/confirmations/tick" >> /var/log/melania-tick.log 2>&1

# Processor: respaldo del auto-trigger del webhook
*/5  * * * * curl -sS -X POST -H "Authorization: Bearer $TOKEN" "https://sell-medinet-backend.onrender.com/confirmations/process-inbound?limit=200" >> /var/log/melania-process.log 2>&1
```

`crontab -l` para ver. `crontab -e` para editar (cuidado de pegar al FINAL, no
en el medio de una línea existente).

---

## Operaciones comunes

### Forzar un ciclo manualmente (sin esperar al cron)

```bash
TOKEN=<CONFIRMATIONS_INTAKE_TOKEN>
curl -sS -X POST -H "Authorization: Bearer $TOKEN" https://sell-medinet-backend.onrender.com/confirmations/tick; echo
curl -sS -X POST -H "Authorization: Bearer $TOKEN" "https://sell-medinet-backend.onrender.com/confirmations/process-inbound?limit=200"; echo
```

### Correr el ingest a mano

```bash
cd /root/clinyco_AI && set -a; . .env; set +a
node scripts/melania-ingest.mjs --dry-run --days 7   # ver qué traería sin postear
node scripts/melania-ingest.mjs --days 7             # live
```

### Ver el estado de una cita

```bash
psql "$DATABASE_URL" -c "
SELECT external_id, state, patient_name, patient_phone, branch_name,
       first_msg_sent_at, last_inbound_at, reminder_sent_at, appointment_at
FROM confirmations.appointments WHERE external_id = <ID>;
"
```

### Ver clasificaciones de un paciente

```bash
psql "$DATABASE_URL" -c "
SELECT ic.decided_at, ic.intent, ic.confidence, ic.raw_message, ic.model
FROM confirmations.inbound_classifications ic
JOIN confirmations.appointments a ON a.id = ic.appointment_id
WHERE a.patient_phone = '+569XXXXXXXX'
ORDER BY ic.decided_at DESC;
"
```

### Proteger citas para que NO reciban HSM (evitar spam masivo)

Útil después de un ingest grande de citas viejas:

```bash
psql "$DATABASE_URL" -c "
UPDATE confirmations.appointments
SET first_msg_sent_at = now()
WHERE first_msg_sent_at IS NULL;
"
```

Las marca como "ya enviadas" → el scheduler las salta. Solo procesará citas
nuevas de ahí en adelante.

---

## Cómo agregar / cambiar datos de sucursales

### Dirección de sucursal
Viene de Medinet (`sucursal.direccion` en `all-appointments`) y se persiste en
`confirmations.appointments.branch_address` en cada intake. **Single source of
truth = Medinet** — un cambio de dirección allá propaga al próximo ingest.

Si Medinet devuelve `direccion: null` para una sucursal (pasa con Santiago y
telemedicina), el ack omite la línea de dirección. Para forzar una dirección
manual en una cita puntual:

```bash
psql "$DATABASE_URL" <<'SQL'
UPDATE confirmations.appointments
SET branch_address = 'Tu dirección acá'
WHERE external_id = <ID>;
SQL
```

### Extras de sucursal (parking, accesos, etc.)
Datos estáticos que NO están en Medinet (ej. "150 estacionamientos"). Viven en
`confirmations/acknowledgments.js` → const `BRANCH_EXTRAS`, keyed por `branch_id`:

```js
const BRANCH_EXTRAS = {
  39: "🅿️ Contamos con 150 estacionamientos subterráneos (ingreso al final de la calle lateral).",
  // agregar más sucursales acá
};
```

Editar el map = commit + PR + deploy.

---

## Plantillas HSM (Meta Business Manager)

Estado actual (2026-05):
| Template | Idioma | Uso | Env var |
|---|---|---|---|
| `cly_confirm_appointment_v1` | es_CL | 1er mensaje | `CHATWOOT_HSM_CONFIRM_INITIAL` |
| `cly_confirm_reminder_76h_v2` | es_CL | recordatorio T-76h | `CHATWOOT_HSM_CONFIRM_REMINDER` |

> `cly_confirm_reminder_76h_v1` quedó en idioma incorrecto — NO usar.
> El language code (`CHATWOOT_HSM_LANGUAGE=es_CL`) debe coincidir EXACTO con el
> registrado en Meta, sino Meta rechaza con `(#132001) Template name does not
> exist in the translation`.

Para cambiar el texto de una plantilla: registrar `_v3` en Meta BM (Meta no deja
editar aprobadas), esperar aprobación, actualizar la env var, redeploy.
Ver `docs/whatsapp-templates.md`.

---

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `(#132001) Template name does not exist` en outbound_messages.error | language code no matchea Meta, o template name incorrecto | Verificar `CHATWOOT_HSM_LANGUAGE=es_CL` y el nombre exacto del template |
| `422 invalid source id for whatsapp inbox` | source_id con `+` | Ya manejado por `toChatwootSourceId` (strip de no-dígitos) |
| Mensaje llega como texto plano, no HSM, + `Error al enviar` | shape de `template_params` incompleto | Verificar que se manda `name+category+language+processed_params.body` |
| `process-inbound` con `scanned:0` pese a respuestas de pacientes | webhook no llega al backend | Verificar webhook en Chatwoot (Settings→Integrations→Webhook) apunta a `/chatwoot-webhook/events` |
| `401 invalid_or_missing_signature` en webhook | HMAC mismatch | Setear `CHATWOOT_WEBHOOK_REQUIRE_SIG=false` o sincronizar `CHATWOOT_WEBHOOK_SECRET` con el de Chatwoot |
| ingest `FATAL: Falta SELL_MEDINET_INTAKE_TOKEN` | env no cargada en el VPS | `set -a; . .env; set +a` antes de correr |
| ingest `login falló` / 401 Medinet | credenciales JWT muertas | Las que funcionan son `MEDINET_USER`/`MEDINET_USER_KEY`. El usuario `rvillagran` está desactivado. Auth scheme: `Authorization: MEDINET_JWT <token>`, login en `POST /token-login/` |
| ack duplicado (paciente recibe 2x) | race entre processors concurrentes | Ya mitigado con `FOR UPDATE SKIP LOCKED`. Si persiste, revisar que no haya 2 crons solapados |
| cita cancelada y paciente sigue escribiendo sin respuesta | by design: estados terminales no re-matchean | Decisión de producto — cancelar es definitivo |

### Cuándo el clasificador usa el fallback heurístico
Si `ANTHROPIC_API_KEY` falta o la API falla, el classifier cae a matching por
keywords (cubre SÍ/NO/REAGENDAR y variantes comunes). El campo `model` en
`inbound_classifications` dice `heuristic` o `fallback` en ese caso.

---

## State machine

```
scheduled ──tick──► first_msg_sent ──┬─ confirm    ─► confirmed
                                     ├─ cancel     ─► cancelled
                                     ├─ reschedule ─► reschedule_requested
                                     └─ tick T-76h ─► reminder_sent ─► (mismas terminales)
```

`other`/`ambiguous` no cambian el estado, solo bumpean `last_inbound_at` y mandan
el ack "no entendí".

---

## Mantenimiento

- **Rotación de logs**: `/etc/logrotate.d/melania` (weekly, rotate 4, compress,
  copytruncate). Sin esto los logs crecen indefinidamente.
- **Token Medinet JWT**: se refresca solo cada 22h vía `getJwtToken()`. Si las
  credenciales cambian, actualizar `MEDINET_USER`/`MEDINET_USER_KEY` en `.env`.
- **Deploys de Render**: manuales. Tras mergear un PR, Manual Deploy → Deploy
  latest commit.
