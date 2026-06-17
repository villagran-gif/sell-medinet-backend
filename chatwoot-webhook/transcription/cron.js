// Self-cron interno para reprocesar transcripciones pendientes/failed.
//
// Se ejecuta dentro del proceso del backend (no necesita un Cron Job de
// Render aparte). Opt-in con CHATWOOT_TRANSCRIPTION_CRON_ENABLED=true.
//
// Se arranca desde chatwoot-webhook/index.js después de las migraciones.
// Idempotente: si ya hay un timer activo, no crea otro.

import { retryPending } from "./handler.js";

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_LIMIT = 10;

let timer = null;

export function startTranscriptionCron({
  intervalMs = Number(process.env.CHATWOOT_TRANSCRIPTION_CRON_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  limit = Number(process.env.CHATWOOT_TRANSCRIPTION_CRON_LIMIT) || DEFAULT_LIMIT,
} = {}) {
  if (timer) return;
  if (process.env.CHATWOOT_TRANSCRIPTION_CRON_ENABLED !== "true") {
    console.log("[transcription-cron] disabled (set CHATWOOT_TRANSCRIPTION_CRON_ENABLED=true to enable)");
    return;
  }

  const tick = async () => {
    try {
      const result = await retryPending({ limit });
      if (result.processed > 0) {
        console.log(
          `[transcription-cron] processed=${result.processed} found=${result.found}`
        );
      }
    } catch (err) {
      console.error("[transcription-cron] tick failed:", err.message);
    }
  };

  // Primer tick inmediato (catch-up al boot), después intervalo.
  tick();
  timer = setInterval(tick, intervalMs);
  // No bloquea el shutdown elegante del proceso.
  if (timer.unref) timer.unref();
  console.log(
    `[transcription-cron] started: interval=${intervalMs}ms limit=${limit}`
  );
}

export function stopTranscriptionCron() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
