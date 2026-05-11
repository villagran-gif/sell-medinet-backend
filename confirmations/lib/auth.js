/**
 * Bearer auth para endpoints internos del módulo confirmations.
 *
 * Token compartido en CONFIRMATIONS_INTAKE_TOKEN. Usado por clinyco_AI
 * (VPS chileno con acceso geo a Medinet) para empujar citas a este
 * backend en Render. También sirve para /tick desde un cron externo.
 *
 * Si la env var no está seteada, todos los requests fallan con 500
 * (defensa: nunca dejar pasar sin auth por config faltante).
 */
export function requireBearer(req, res, next) {
  const expected = process.env.CONFIRMATIONS_INTAKE_TOKEN;
  if (!expected) {
    return res.status(500).json({
      error: "server_misconfigured",
      message: "CONFIRMATIONS_INTAKE_TOKEN no configurado en el backend",
    });
  }

  const header = req.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : null;

  if (!token || token !== expected) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Bearer token inválido o ausente",
    });
  }

  return next();
}
