import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-API-Key, Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => {
  res.send("OK - sell-medinet-backend v2");
});

app.post("/medinet/import", (req, res) => {
  // Logs SIEMPRE (aunque falle auth)
  console.log("=== IMPORT HIT ===", new Date().toISOString());
  console.log("ORIGIN:", req.headers.origin || "no-origin");
  console.log("REFERER:", req.headers.referer || "no-referer");
  console.log("CONTENT-TYPE:", req.headers["content-type"] || "none");
  console.log("HAS X-API-KEY:", req.headers["x-api-key"] ? "YES" : "NO");
  console.log("BODY:", req.body);

  const apiKey = (process.env.API_KEY || "").trim();

  if (!apiKey) {
    console.log("ERROR: API_KEY no configurada");
    return res.status(500).json({
      status: "error",
      message: "Backend sin API_KEY configurada en Render (Environment).",
    });
  }

  const requestApiKey = (req.header("X-API-Key") || "").trim();
  if (requestApiKey !== apiKey) {
    console.log("ERROR: API key inválida");
    return res.status(401).json({
      status: "error",
      message: "API key inválida",
    });
  }

  // Log de headers resumidos (sin exponer el API key)
  console.log("HEADERS:", {
    origin: req.headers.origin,
    referer: req.headers.referer,
    "content-type": req.headers["content-type"],
    "x-api-key": req.headers["x-api-key"] ? "PRESENTE" : "AUSENTE",
  });

  const response = {
    status: "ok",
    message: "Conectado ✅ (backend Render)",
    received: req.body,
  };

  console.log("RESPONDO 200:", response);
  return res.status(200).json(response);
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
