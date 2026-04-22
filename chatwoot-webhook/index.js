import { Router } from "express";
import { runMigrations } from "./migrations/runner.js";
import healthRouter from "./routes/health.js";
import eventsRouter from "./routes/events.js";

export function createChatwootWebhookRouter({ autoMigrate = true } = {}) {
  const router = Router();

  router.use("/health", healthRouter);
  router.use("/events", eventsRouter);

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
      })
      .catch((err) => {
        console.error("[chatwoot-webhook] migrations failed:", err.message);
      });
  }

  return router;
}
