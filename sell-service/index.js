/**
 * sell-service: emulador Zendesk Sell API v2/v3 hacia Frappe Cloud.
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
 * Endpoints v0.2 implementados:
 *   GET    /health
 *   GET    /v2/pipelines [?ids=]
 *   GET    /v2/stages [?pipeline_id=&ids=&active=&sort_by=&per_page=]
 *   GET    /v2/contact/custom_fields, /v2/deal/custom_fields, /v2/lead/custom_fields
 *   GET    /v2/users
 *   GET    /v2/lead_sources, /v2/deal_sources
 *   GET    /v2/contacts/:id  |  GET /v2/contacts?ids=
 *   POST   /v2/contacts
 *   PUT    /v2/contacts/:id
 *   GET    /v2/deals/:id  |  GET /v2/deals?ids=
 *   POST   /v2/deals (con child tables Comisiones + Colaboradores)
 *   PUT    /v2/deals/:id
 *   GET    /v2/leads/:id  |  GET /v2/leads?ids=
 *   POST   /v2/leads
 *   PUT    /v2/leads/:id
 *   POST   /v2/notes
 *   POST   /v3/contacts/search  (api.sell.zendesk.com compat)
 *   POST   /v3/deals/search
 *
 * Pendiente v0.3:
 *   - Search queries complejas (and/or anidados, sort)
 *   - Mirror mode dual-write Zendesk + Frappe
 *   - DELETE endpoints
 */

import { Router } from "express";
import { requireApiKey } from "./lib/auth.js";
import { errorHandler } from "./lib/errors.js";
import healthRouter from "./routes/health.js";
import metaRouter from "./routes/meta.js";
import contactsRouter from "./routes/contacts.js";
import dealsRouter from "./routes/deals.js";
import leadsRouter from "./routes/leads.js";
import notesRouter from "./routes/notes.js";
import searchRouter from "./routes/search.js";

export function createSellRouter() {
  const router = Router();

  // /health: sin auth (probes de Render, debug rápido)
  router.use("/health", healthRouter);

  // Auth requerida bajo /v2 y /v3
  router.use("/v2", requireApiKey);
  router.use("/v3", requireApiKey);

  // Meta (read-only): pipelines, stages, custom_fields, users, sources
  router.use("/v2", metaRouter);

  // CRUD
  router.use("/v2/contacts", contactsRouter);
  router.use("/v2/deals", dealsRouter);
  router.use("/v2/leads", leadsRouter);
  router.use("/v2/notes", notesRouter);

  // Search v3 (Zendesk Sell hosted en api.sell.zendesk.com — acá unificado)
  router.use("/v3", searchRouter);

  router.use(errorHandler);

  return router;
}

export default createSellRouter;
