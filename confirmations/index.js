import { Router } from "express";
import { runMigrations } from "./migrations/runner.js";
import healthRouter from "./routes/health.js";
import intakeRouter from "./routes/intake.js";

export function createConfirmationsRouter({ autoMigrate = true } = {}) {
  const router = Router();

  router.use("/health", healthRouter);
  router.use("/intake", intakeRouter);

  if (autoMigrate) {
    runMigrations()
      .then((applied) => {
        if (applied.length) {
          console.log(
            `[confirmations] migrations applied: ${applied.join(", ")}`
          );
        } else {
          console.log("[confirmations] migrations up to date");
        }
      })
      .catch((err) => {
        console.error("[confirmations] migrations failed:", err.message);
      });
  }

  return router;
}
