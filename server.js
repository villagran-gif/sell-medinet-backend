import express from "express";
import { randomUUID } from "crypto";
import { createSupportRouter } from "./support-service/index.js";

const app = express();
const PORT = process.env.PORT || 3000;

const IDENTIFIER_TYPES = { DNI: "DNI", RUN: "RUN" };

app.use(express.json({ limit: "1mb" }));

// ======================
// support-service (opt-in vía SUPPORT_ENABLED=true)
// Reemplazo incremental de Zendesk Support. Mientras esté apagado, el módulo
// no toca DB ni corre migraciones. Ver support-service/README.md.
// ======================
if (process.env.SUPPORT_ENABLED === "true") {
  app.use(
    "/support",
    createSupportRouter({
      autoMigrate: process.env.SUPPORT_AUTO_MIGRATE !== "false",
    })
  );
  console.log("[support-service] mounted at /support");
} else {
  console.log("[support-service] disabled (set SUPPORT_ENABLED=true to enable)");
}

// ======================
// In-memory store con TTL
// ======================
const TTL_MINUTES = Number(process.env.TTL_MINUTES || 60);
const TTL_MS = Math.max(1, TTL_MINUTES) * 60 * 1000;

const store = new Map(); // key -> { payload, expiresAt }

function cleanupStore() {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (!v || v.expiresAt <= now) store.delete(k);
  }
}
setInterval(cleanupStore, 60 * 1000).unref();

// ======================
// Helpers RUN / DNI (tu código original intacto)
// ======================
const normalizeDni = (value = "") => value.replace(/\D/g, "");

const computeRunVerifier = (digits) => {
  let sum = 0;
  let multiplier = 2;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  if (remainder === 11) return "0";
  if (remainder === 10) return "K";
  return String(remainder);
};

const normalizeAndValidateRun = (value = "") => {
  const normalizedInput = String(value).toUpperCase().trim();
  const compactValue = normalizedInput.replace(/[.\s-]+/g, "");

  if (!compactValue) return { isValid: false, error: "RUN vacío" };

  if (!/^\d{1,8}[0-9K]$/.test(compactValue)) {
    return { isValid: false, error: "RUN inválido. Usa un RUN chileno válido con DV (0-9 o K)" };
  }

  const body = compactValue.slice(0, -1);
  const verifier = compactValue.slice(-1);
  const expectedVerifier = computeRunVerifier(body);

  if (verifier !== expectedVerifier) {
    return { isValid: false, error: "RUN inválido. Dígito verificador incorrecto" };
  }

  return { isValid: true, normalized: `${body}-${verifier}` };
};

const formatRunWithDots = (normalizedRun = "") => {
  const [body, verifier] = normalizedRun.split("-");
  const bodyWithDots = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${bodyWithDots}-${verifier}`;
};

const validateApiKey = (req, res) => {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    res.status(500).json({
      status: "error",
      message: "Backend sin API_KEY configurada en Render (Environment).",
    });
    return false;
  }

  const requestApiKey = req.header("X-API-Key");
  if (requestApiKey !== apiKey) {
    res.status(401).json({ status: "error", message: "API key inválida" });
    return false;
  }
  return true;
};

// ======================
// CORS solo para Medinet (GET payload)
// ======================
const MEDINET_ORIGIN = "https://clinyco.medinetapp.com";

function setMedinetCors(res) {
  res.setHeader("Access-Control-Allow-Origin", MEDINET_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

app.options("/medinet/payload/:key", (_req, res) => {
  setMedinetCors(res);
  return res.status(204).send("");
});

// ======================
// Routes
// ======================
app.get("/", (_req, res) => res.send("OK - sell-medinet-backend"));

app.post("/medinet/import", (req, res) => {
  if (!validateApiKey(req, res)) return;

  const payload = req.body || {};
  const key = `mf_${randomUUID()}`;

  store.set(key, {
    payload,
    expiresAt: Date.now() + TTL_MS,
  });

  const baseMedinetNew =
    String(process.env.MEDINET_NEW_URL || "https://clinyco.medinetapp.com/pacientes/nuevo/")
      .trim()
      .replace(/\/?$/, "/"); // asegura trailing /

  const download_url = `${baseMedinetNew}?mf_key=${encodeURIComponent(key)}`;

  return res.status(200).json({
    status: "ok",
    message: "Listo ✅ (payload guardado)",
    key,
    download_url,
  });
});

app.get("/medinet/payload/:key", (req, res) => {
  setMedinetCors(res);

  const key = String(req.params.key || "").trim();
  if (!key) return res.status(400).json({ status: "error", message: "key requerido" });

  const entry = store.get(key);
  if (!entry) return res.status(404).json({ status: "error", message: "key no encontrada/expirada" });

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return res.status(404).json({ status: "error", message: "key expirada" });
  }

  return res.status(200).json(entry.payload);
});

// Tu endpoint existente, intacto
app.post("/medinet/search", (req, res) => {
  if (!validateApiKey(req, res)) return;

  const identifierType = String(req.body?.identifierType || "").toUpperCase();
  const identifierValue = String(req.body?.identifierValue || "");

  if (!Object.values(IDENTIFIER_TYPES).includes(identifierType)) {
    return res.status(400).json({ status: "error", message: "identifierType inválido. Usa DNI o RUN" });
  }

  if (!identifierValue.trim()) {
    return res.status(400).json({ status: "error", message: "identifierValue es requerido" });
  }

  let normalizedIdentifierValue;
  let responseIdentifierValue;

  if (identifierType === IDENTIFIER_TYPES.DNI) {
    normalizedIdentifierValue = normalizeDni(identifierValue);
    if (!normalizedIdentifierValue) {
      return res.status(400).json({ status: "error", message: "DNI inválido. Debe contener solo dígitos" });
    }
    responseIdentifierValue = normalizedIdentifierValue;
  }

  if (identifierType === IDENTIFIER_TYPES.RUN) {
    const runResult = normalizeAndValidateRun(identifierValue);
    if (!runResult.isValid) {
      return res.status(400).json({ status: "error", message: runResult.error });
    }
    normalizedIdentifierValue = runResult.normalized;
    responseIdentifierValue = formatRunWithDots(normalizedIdentifierValue);
  }

  return res.status(200).json({
    status: "ok",
    message: "Búsqueda preparada",
    search: {
      identifierType,
      identifierValue: responseIdentifierValue,
      identifierValueNormalized: normalizedIdentifierValue,
      backendFieldMap: {
        type: identifierType === IDENTIFIER_TYPES.RUN ? "run" : "dni",
        value: normalizedIdentifierValue,
      },
    },
  });
});

app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ status: "error", message: "JSON inválido en el body" });
  }
  return next(error);
});

const server = app.listen(PORT, () => console.log(`Listening on ${PORT}`));

// ======================
// Graceful shutdown
// ======================
// Render envía SIGTERM en cada deploy/reinicio. Sin manejo explícito el proceso
// muere de golpe y corta conexiones HTTP en vuelo. Aquí cerramos el listener,
// dejamos que las requests activas terminen, y luego salimos. Máximo 25s
// (Render hace SIGKILL a los 30s).
const SHUTDOWN_TIMEOUT_MS = 25_000;
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} recibido, cerrando servidor...`);

  const forceExit = setTimeout(() => {
    console.error("[shutdown] timeout alcanzado, forzando salida");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      console.error("[shutdown] error cerrando HTTP:", err);
      process.exit(1);
    }
    console.log("[shutdown] HTTP cerrado, saliendo limpio");
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
