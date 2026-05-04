import crypto from "node:crypto";

/**
 * Verifica HMAC-SHA256 de un raw body contra el header X-Chatwoot-Hmac-Signature.
 *
 * Acepta tanto "sha256=<hex>" como "<hex>" a secas para robustez.
 * Devuelve true solo si la firma matchea exactamente (comparación timing-safe).
 */
export function verifyHmac(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret || !rawBody) return false;

  const provided = String(signatureHeader).replace(/^sha256=/i, "").trim();
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  if (provided.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}
