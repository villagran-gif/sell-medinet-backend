// Builders mínimos de TwiML (el XML que Twilio espera como respuesta).
// TwiML es un XML chico y estable; no justifica traer el SDK de Twilio —
// el repo mantiene las dependencias al mínimo (solo express + pg).

function esc(s) {
  return String(s ?? "").replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  }[c]));
}

function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
}

export function response(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;
}

export function say(text, { language = "es-MX", voice } = {}) {
  return `<Say${attrs({ language, voice })}>${esc(text)}</Say>`;
}

export function hangup() {
  return "<Hangup/>";
}

/**
 * `<Dial>` con un `<Number>` hijo. `action` recibe el resultado del intento
 * (`DialCallStatus`) para decidir el fallback a buzón.
 */
export function dialNumber(number, { callerId, timeout = 20, action, method = "POST" } = {}) {
  return `<Dial${attrs({ callerId, timeout, action, method })}><Number>${esc(number)}</Number></Dial>`;
}

/**
 * `<Record>` para buzón de voz. `action` recibe `RecordingUrl` +
 * `RecordingDuration` cuando el llamante cuelga o termina la grabación.
 */
export function record({ action, method = "POST", maxLength = 120, playBeep = true, finishOnKey = "#" }) {
  return `<Record${attrs({ action, method, maxLength, playBeep, finishOnKey })}/>`;
}
