// Auth simple por header X-API-Key contra SUPPORT_API_KEY.
// Misma forma que los endpoints existentes de Medinet, pero con su propia
// clave para que un leak de una no comprometa a la otra.

export function requireApiKey(req, res, next) {
  const expected = process.env.SUPPORT_API_KEY;
  if (!expected) {
    return res.status(500).json({
      error: {
        title: "Misconfigured",
        message: "SUPPORT_API_KEY not set in environment",
      },
    });
  }
  const provided = req.header("X-API-Key");
  if (provided !== expected) {
    return res.status(401).json({
      error: { title: "Unauthorized", message: "invalid api key" },
    });
  }
  next();
}
