// Auth header X-API-Key contra SELL_API_KEY (ambiente Render).
// Mismo patrón que support-service. Cuando los consumers (clinyco_AI,
// box-ai-clinyco, ZAPS) flippeen su SELL_API_BASE a apuntar acá, deben
// también pasar la X-API-Key correspondiente.

export function requireApiKey(req, res, next) {
  const expected = process.env.SELL_API_KEY;
  if (!expected) {
    return res.status(500).json({
      error: {
        title: "Misconfigured",
        message: "SELL_API_KEY not set in environment",
      },
    });
  }
  const provided =
    req.header("X-API-Key") ||
    req.header("Authorization")?.replace(/^Bearer\s+/i, ""); // also accept Bearer for Zendesk Sell compat
  if (provided !== expected) {
    return res.status(401).json({
      error: { title: "Unauthorized", message: "invalid api key" },
    });
  }
  next();
}
