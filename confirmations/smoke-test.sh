#!/usr/bin/env bash
#
# confirmations/smoke-test.sh — smoke test end-to-end del módulo MelanIA.
#
# Empuja una cita de PRUEBA (external_id en rango 999xxx, no colisiona con
# Medinet) con un teléfono que tú controlas, dispara el scheduler y reporta
# el resultado. Idempotente: re-correrlo actualiza la misma cita.
#
# Uso:
#   CONFIRMATIONS_INTAKE_TOKEN=xxx ./confirmations/smoke-test.sh +569XXXXXXXX
#   ./confirmations/smoke-test.sh +569XXXXXXXX <token>
#
# Env:
#   SELL_MEDINET_BACKEND_URL   default https://sell-medinet-backend.onrender.com
#   CONFIRMATIONS_INTAKE_TOKEN Bearer del /intake (o pásalo como 2º argumento)
#
# Nota: si el backend tiene CHATWOOT_DRY_RUN=true, el paso "tick" NO envía
# WhatsApp real — solo loguea el payload. Para recibir el mensaje de verdad,
# el backend debe tener CHATWOOT_DRY_RUN=false y las plantillas sincronizadas
# en Chatwoot.

set -euo pipefail

BACKEND_URL="${SELL_MEDINET_BACKEND_URL:-https://sell-medinet-backend.onrender.com}"
BACKEND_URL="${BACKEND_URL%/}"
PHONE="${1:-}"
TOKEN="${2:-${CONFIRMATIONS_INTAKE_TOKEN:-}}"
EXTERNAL_ID="${SMOKE_EXTERNAL_ID:-999001}"

if [[ -z "$PHONE" ]]; then
  echo "ERROR: falta el teléfono de prueba." >&2
  echo "Uso: $0 +569XXXXXXXX [token]" >&2
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: falta CONFIRMATIONS_INTAKE_TOKEN (env o 2º argumento)." >&2
  exit 1
fi

# Fecha 5 días en el futuro (GNU date o BSD date).
FUTURE_DATE="$(date -u -d '+5 days' +%Y-%m-%d 2>/dev/null || date -u -v+5d +%Y-%m-%d)"
APPOINTMENT_AT="${FUTURE_DATE}T15:00:00-04:00"

echo "=================================================="
echo " MelanIA smoke test"
echo "=================================================="
echo " backend       : $BACKEND_URL"
echo " phone         : $PHONE"
echo " external_id   : $EXTERNAL_ID (prueba)"
echo " appointment_at: $APPOINTMENT_AT"
echo "=================================================="
echo

# ── 1. Pre-check: health ─────────────────────────────────────────
echo "[1/4] GET /confirmations/health"
HEALTH="$(curl -sS "$BACKEND_URL/confirmations/health")"
echo "      → $HEALTH"
if [[ "$HEALTH" != *'"db":"ok"'* ]]; then
  echo "ERROR: el módulo confirmations no está sano (db != ok)." >&2
  echo "       Revisa CONFIRMATIONS_ENABLED=true y la conexión a Postgres." >&2
  exit 1
fi
echo

# ── 2. Intake: empujar la cita de prueba ─────────────────────────
echo "[2/4] POST /confirmations/intake"
INTAKE_PAYLOAD=$(cat <<JSON
{
  "external_id": $EXTERNAL_ID,
  "branch_id": 2,
  "branch_name": "Smoke Test",
  "specialty": "Medicina General",
  "professional": "Dra. Smoke Test",
  "appointment_at": "$APPOINTMENT_AT",
  "duration_min": 30,
  "medinet_state": "Agendado",
  "patient": {
    "run": "11.111.111-1",
    "name": "Paciente Smoke Test",
    "phone": "$PHONE",
    "email": "smoke-test@example.com"
  }
}
JSON
)
INTAKE_RESP="$(curl -sS -X POST "$BACKEND_URL/confirmations/intake" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$INTAKE_PAYLOAD")"
echo "      → $INTAKE_RESP"
if [[ "$INTAKE_RESP" != *'"status":"ok"'* ]]; then
  echo "ERROR: el intake no respondió ok. Revisa el token y el payload." >&2
  exit 1
fi
echo

# ── 3. Tick: disparar el scheduler ───────────────────────────────
echo "[3/4] POST /confirmations/tick"
TICK_RESP="$(curl -sS -X POST "$BACKEND_URL/confirmations/tick" \
  -H "Authorization: Bearer $TOKEN")"
echo "      → $TICK_RESP"
echo

# ── 4. Post-check: health de nuevo ───────────────────────────────
echo "[4/4] GET /confirmations/health (post)"
HEALTH2="$(curl -sS "$BACKEND_URL/confirmations/health")"
echo "      → $HEALTH2"
echo

echo "=================================================="
if [[ "$TICK_RESP" == *'"dry_run":true'* ]]; then
  echo " RESULTADO: tick corrió en DRY-RUN."
  echo " El backend NO envió WhatsApp real — revisa los logs de Render,"
  echo " deberías ver una línea [chatwoot-client/dry-run] con el payload."
  echo
  echo " Para probar el envío real:"
  echo "   1. En Render: CHATWOOT_DRY_RUN=false + redeploy."
  echo "   2. Chatwoot: Sync Templates en el inbox WhatsApp."
  echo "   3. Re-corre este script."
else
  echo " RESULTADO: tick corrió en modo LIVE."
  echo " Deberías recibir el WhatsApp en $PHONE en segundos."
  echo " Si no llega: revisa logs de Render + que las plantillas estén"
  echo " sincronizadas y Activas en Chatwoot."
fi
echo
echo " Para probar el inbound (clasificador): responde al WhatsApp con"
echo " 'SÍ' / 'NO' / 'REAGENDAR' y luego corre:"
echo "   curl -X POST $BACKEND_URL/confirmations/process-inbound \\"
echo "     -H \"Authorization: Bearer \$CONFIRMATIONS_INTAKE_TOKEN\""
echo "=================================================="
