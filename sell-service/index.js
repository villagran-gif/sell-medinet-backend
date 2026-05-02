/**
 * sell-service: emulador Zendesk Sell API v2 hacia Frappe Cloud.
 *
 * Diseño strangler-fig:
 *
 *   clinyco_AI ───┐
 *   box-ai-clinyco ┼──→ sell-service ──→ Frappe Cloud REST API
 *   ZAPS ──────────┘    (este módulo)
 *
 * Cada consumer cambia su ZENDESK_SELL_API_BASE / SELL_API_BASE env var para
 * apuntar a sell-medinet-backend.onrender.com en lugar de api.getbase.com.
 * sell-service traduce request/response Zendesk Sell ↔ Frappe REST.
 *
 * Opt-in: SELL_SERVICE_ENABLED=true en Render env.
 *
 * Endpoints implementados (v0.1):
 *   GET  /health
 *   GET  /v2/pipelines
 *   GET  /v2/stages [?pipeline_id=]
 *   GET  /v2/contact/custom_fields
 *   GET  /v2/deal/custom_fields
 *   GET  /v2/lead/custom_fields
 *   GET  /v2/users
 *   GET  /v2/lead_sources
 *   GET  /v2/deal_sources
 *
 * Endpoints PENDIENTES (v0.2+):
 *   GET/POST/PUT /v2/contacts/[:id]
 *   GET/POST/PUT /v2/deals/[:id]
 *   GET/POST/PUT /v2/leads/[:id]
 *   POST /v2/notes
 *   POST /v3/contacts/search (api.sell.zendesk.com)
 *   POST /v3/deals/search (api.sell.zendesk.com)
 */

import { Router } from "express";
import { requireApiKey } from "./lib/auth.js";
import { errorHandler } from "./lib/errors.js";
import healthRouter from "./routes/health.js";
import metaRouter from "./routes/meta.js";

export function createSellRouter() {
  const router = Router();

  // /health: sin auth (probes de Render, debug rápido)
  router.use("/health", healthRouter);

  // Todo lo demás bajo /v2 requiere X-API-Key (o Bearer del legacy Zendesk Sell).
  router.use("/v2", requireApiKey);
  router.use("/v2", metaRouter); // pipelines, stages, custom_fields, users, sources

  // TODO: contacts, deals, leads, notes routers (v0.2)

  router.use(errorHandler);

  return router;
}

export default createSellRouter;
