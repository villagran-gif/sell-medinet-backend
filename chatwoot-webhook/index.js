import { Router } from "express";
import { runMigrations } from "./migrations/runner.js";
import healthRouter from "./routes/health.js";
import eventsRouter from "./routes/events.js";
import transcriptionsRouter from "./routes/transcriptions.js";
import missedCallsRouter from "./routes/missed-calls.js";
import twilioCallbackRouter from "./routes/twilio-callback.js";
import { startTranscriptionCron } from "./transcription/cron.js";
import { startPolling } from "./transcription/polling.js";

export function createChatwootWebhookRouter({ autoMigrate = true } = {}) {
  const router = Router();

  router.use("/health", healthRouter);
  router.use("/events", eventsRouter);
  router.use("/transcriptions", transcriptionsRouter);
  router.use("/missed-calls", missedCallsRouter);
  router.use("/twilio", twilioCallbackRouter);

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
        startTranscriptionCron();
        startPolling();
      })
      .catch((err) => {
        console.error("[chatwoot-webhook] migrations failed:", err.message);
      });
  } else {
    startTranscriptionCron();
    startPolling();
  }

  return router;
}
