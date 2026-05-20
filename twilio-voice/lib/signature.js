import crypto from "node:crypto";

/**
 * Valida la firma `X-Twilio-Signature` de un webhook de Twilio.
 *
 * Algoritmo oficial (https://www.twilio.com/docs/usage/security#validating-requests):
 *  1. Partir de la URL completa que Twilio invocó (incluyendo querystring).
 *  2. Para POST `application/x-www-form-urlencoded`: ordenar los parámetros
 *     del body alfabéticamente por clave y concatenar `key+value` (sin
 *     separadores) al final de la URL.
 *  3. HMAC-SHA1 de ese string usando el Auth Token de la cuenta como clave.
 *  4. Base64. Comparar (timing-safe) contra el header.
 *
 * La URL debe ser EXACTAMENTE la que Twilio usó. Detrás del proxy de Render
 * se reconstruye con proto/host forwardeados o con
 * `TWILIO_VOICE_PUBLIC_BASE_URL` (ver routes/voice.js).
 */
export function computeTwilioSignature(authToken, url, params) {
  let data = String(url || "");
  if (params && typeof params === "object") {
    for (const key of Object.keys(params).sort()) {
      data += key + (params[key] ?? "");
    }
  }
  return crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
}

export function validateTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature || !url) return false;
  const expected = computeTwilioSignature(authToken, url, params || {});
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
