import { Router } from "express";
import { runMigrations } from "./migrations/runner.js";
import healthRouter from "./routes/health.js";
import eventsRouter from "./routes/events.js";
import transcriptionsRouter from "./routes/transcriptions.js";
import { startTranscriptionCron } from "./transcription/cron.js";

export function createChatwootWebhookRouter({ autoMigrate = true } = {}) {
  const router = Router();

  router.use("/health", healthRouter);
  router.use("/events", eventsRouter);
  router.use("/transcriptions", transcriptionsRouter);

  if (autoMigrate) {
    runMigrations()
      .then((applied) => {
        if (applied.length) {
          console.log(
            `[chatwoot-webhook] migrations applied: ${applied.join(", ")}`
          );
        } else {
          console.log("[chatwoot-webhook] migrations up to date");
        }
        // Arranca el cron solo después que las migraciones estén OK,
        // así garantizamos que la tabla call_transcriptions existe.
        startTranscriptionCron();
      })
      .catch((err) => {
        console.error("[chatwoot-webhook] migrations failed:", err.message);
      });
  } else {
    // Si autoMigrate está apagado, asumimos schema ya aplicado y arrancamos
    // el cron igual (sigue siendo opt-in por env var).
    startTranscriptionCron();
  }

  return router;
}
