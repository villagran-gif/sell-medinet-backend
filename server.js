import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => {
  res.send("OK - sell-medinet-backend");
});

app.post("/medinet/import", (req, res) => {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      status: "error",
      message: "Backend sin API_KEY configurada en Render (Environment).",
    });
  }

  const requestApiKey = (req.header("X-API-Key") || "").trim();
  if (requestApiKey !== apiKey) {
    return res.status(401).json({ status: "error", message: "API key inválida" });
  }

  console.log("POST /medinet/import from", req.headers.origin || "no-origin");

  return res.status(200).json({
    status: "ok",
    message: "Conectado ✅ (backend Render)",
    received: req.body,
  });
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
