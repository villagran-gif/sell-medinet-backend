import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const IDENTIFIER_TYPES = {
  DNI: "DNI",
  RUN: "RUN",
};

app.use(express.json({ limit: "1mb" }));

const normalizeDni = (value = "") => value.replace(/\D/g, "");

const computeRunVerifier = (digits) => {
  let sum = 0;
  let multiplier = 2;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);

  if (remainder === 11) {
    return "0";
  }

  if (remainder === 10) {
    return "K";
  }

  return String(remainder);
};

const normalizeAndValidateRun = (value = "") => {
  const normalizedInput = String(value).toUpperCase().trim();
  const compactValue = normalizedInput.replace(/[.\s-]+/g, "");

  if (!compactValue) {
    return { isValid: false, error: "RUN vacío" };
  }

  if (!/^\d{1,8}[0-9K]$/.test(compactValue)) {
    return {
      isValid: false,
      error: "RUN inválido. Usa un RUN chileno válido con DV (0-9 o K)",
    };
  }

  const body = compactValue.slice(0, -1);
  const verifier = compactValue.slice(-1);

  const expectedVerifier = computeRunVerifier(body);

  if (verifier !== expectedVerifier) {
    return {
      isValid: false,
      error: "RUN inválido. Dígito verificador incorrecto",
    };
  }

  return {
    isValid: true,
    normalized: `${body}-${verifier}`,
  };
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
    res.status(401).json({
      status: "error",
      message: "API key inválida",
    });
    return false;
  }

  return true;
};

app.get("/", (_req, res) => {
  res.send("OK - sell-medinet-backend");
});

app.post("/medinet/import", (req, res) => {
  if (!validateApiKey(req, res)) {
    return;
  }

  return res.status(200).json({
    status: "ok",
    message: "Conectado ✅ (backend Render)",
    received: req.body,
  });
});

app.post("/medinet/search", (req, res) => {
  if (!validateApiKey(req, res)) {
    return;
  }

  const identifierType = String(req.body?.identifierType || "").toUpperCase();
  const identifierValue = String(req.body?.identifierValue || "");

  if (!Object.values(IDENTIFIER_TYPES).includes(identifierType)) {
    return res.status(400).json({
      status: "error",
      message: "identifierType inválido. Usa DNI o RUN",
    });
  }

  if (!identifierValue.trim()) {
    return res.status(400).json({
      status: "error",
      message: "identifierValue es requerido",
    });
  }

  let normalizedIdentifierValue;
  let responseIdentifierValue;

  if (identifierType === IDENTIFIER_TYPES.DNI) {
    normalizedIdentifierValue = normalizeDni(identifierValue);

    if (!normalizedIdentifierValue) {
      return res.status(400).json({
        status: "error",
        message: "DNI inválido. Debe contener solo dígitos",
      });
    }

    responseIdentifierValue = normalizedIdentifierValue;
  }

  if (identifierType === IDENTIFIER_TYPES.RUN) {
    const runResult = normalizeAndValidateRun(identifierValue);

    if (!runResult.isValid) {
      return res.status(400).json({
        status: "error",
        message: runResult.error,
      });
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
    return res.status(400).json({
      status: "error",
      message: "JSON inválido en el body",
    });
  }

  return next(error);
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
