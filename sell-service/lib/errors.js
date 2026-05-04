/**
 * Express error handler para sell-service.
 *
 * Imita el formato de error de Zendesk Sell para que los clientes existentes
 * (clinyco_AI, box-ai-clinyco) no necesiten cambiar su lógica de manejo de
 * errores al flippear el endpoint base.
 *
 * Zendesk Sell error shape (resumido):
 *   { errors: [ { resource, field, code, message } ] }
 */

export function errorHandler(err, _req, res, _next) {
  console.error("[sell-service] error:", err);

  const status = err.status || 500;
  const message = err.message || "Internal Server Error";

  res.status(status).json({
    errors: [
      {
        resource: "sell-service",
        field: null,
        code: status === 404 ? "not_found" : status === 401 ? "unauthorized" : "internal_error",
        message,
        details: err.frappeData ? { frappe: err.frappeData } : undefined,
      },
    ],
  });
}
