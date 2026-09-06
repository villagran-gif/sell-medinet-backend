// Handler del chatwoot-dispatcher que reenvía un `message_created` a clinyco_AI
// para que el core de AntonIA responda por Chatwoot Cloud.
//
// Best-effort: si falla, el dispatcher registra el error en raw_events.error.
// Sólo se ejecuta para inboxes ruteados a "antonia".
//
// clinyco_AI puede consultar OpenAI y Medinet; esas rutas tienen operaciones
// legítimas que pueden superar ampliamente 8 segundos. El bridge debe darles
// margen suficiente y reportar un timeout explícito si realmente se agota.

const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 10_000;
const configuredTimeoutMs = Number(process.env.ANTONIA_BRIDGE_TIMEOUT_MS);
const TIMEOUT_MS = Math.max(
  MIN_TIMEOUT_MS,
  Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : DEFAULT_TIMEOUT_MS
);

export async function handleInboundEvent(ev) {
  const baseUrl = process.env.CLINYCO_AI_BASE_URL;
  const token = process.env.CHATWOOT_ADAPTER_TOKEN;
  if (!baseUrl || !token) {
    console.warn(
      "[antonia-bridge] skip — falta CLINYCO_AI_BASE_URL o CHATWOOT_ADAPTER_TOKEN"
    );
    return { skipped: true };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/chatwoot/inbound`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(ev.payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`clinyco_AI /chatwoot/inbound ${res.status}: ${body.slice(0, 200)}`);
    }
    return { forwarded: true };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`clinyco_AI /chatwoot/inbound timeout after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
