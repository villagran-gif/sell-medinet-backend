import { Router } from "express";
import { runMigrations } from "./migrations/runner.js";
import { requireApiKey } from "./lib/auth.js";
import { errorHandler } from "./lib/errors.js";
import healthRouter from "./routes/health.js";
import usersRouter from "./routes/users.js";
import ticketsRouter from "./routes/tickets.js";
import searchRouter from "./routes/search.js";
import syncLogRouter from "./routes/sync-log.js";

// Zendesk URLs usan sufijo .json (p.ej. /api/v2/tickets/123.json).
// Lo stripeamos aquí para que el router matchee con/sin sufijo.
function stripJsonSuffix(req, _res, next) {
  const qIdx = req.url.indexOf("?");
  const path = qIdx >= 0 ? req.url.slice(0, qIdx) : req.url;
  const search = qIdx >= 0 ? req.url.slice(qIdx) : "";
  if (path.endsWith(".json")) {
    req.url = path.slice(0, -5) + search;
  }
  next();
}

export function createSupportRouter({ autoMigrate = true } = {}) {
  const router = Router();

  router.use(stripJsonSuffix);

  // /health no requiere auth (lo usan probes y debug rápido).
  router.use("/health", healthRouter);

  // Todo lo demás bajo /api/v2 requiere X-API-Key.
  router.use("/api/v2", requireApiKey);
  router.use("/api/v2/users", usersRouter);
  router.use("/api/v2/tickets", ticketsRouter);
  router.use("/api/v2/search", searchRouter);
  router.use("/api/v2/sync-log", syncLogRouter);

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
