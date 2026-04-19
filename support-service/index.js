import { Router } from "express";
import { runMigrations } from "./migrations/runner.js";
import { requireApiKey } from "./lib/auth.js";
import { errorHandler } from "./lib/errors.js";
import healthRouter from "./routes/health.js";
import usersRouter from "./routes/users.js";

export function createSupportRouter({ autoMigrate = true } = {}) {
  const router = Router();

  // /health no requiere auth (lo usan probes y debug rápido).
  router.use("/health", healthRouter);

  // Todo lo demás bajo /api/v2 requiere X-API-Key.
  router.use("/api/v2", requireApiKey);
  router.use("/api/v2/users", usersRouter);

  router.use(errorHandler);

  if (autoMigrate) {
    runMigrations()
      .then((applied) => {
        if (applied.length > 0) {
          console.log(
            `[support-service] migrations applied: ${applied.join(", ")}`
          );
        } else {
          console.log("[support-service] migrations: nothing to apply");
        }
      })
      .catch((err) => {
        console.error(
          "[support-service] migration error (service may be degraded):",
          err.message
        );
      });
  }

  return router;
}

export default createSupportRouter;
