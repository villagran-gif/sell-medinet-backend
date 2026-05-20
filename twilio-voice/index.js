import { Router } from "express";
import { runMigrations } from "./migrations/runner.js";
import healthRouter from "./routes/health.js";
import voiceRouter from "./routes/voice.js";

export function createTwilioVoiceRouter({ autoMigrate = true } = {}) {
  const router = Router();

  router.use("/health", healthRouter);
  router.use("/", voiceRouter);

  if (autoMigrate) {
    runMigrations()
      .then((applied) => {
        if (applied.length) {
          console.log(
            `[twilio-voice] migrations applied: ${applied.join(", ")}`
          );
        } else {
          console.log("[twilio-voice] migrations up to date");
        }
      })
      .catch((err) => {
        console.error("[twilio-voice] migrations failed:", err.message);
      });
  }

  return router;
}
