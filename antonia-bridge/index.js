// Handler del chatwoot-dispatcher que reenvía un `message_created` a clinyco_AI
// para que el core de AntonIA responda por Chatwoot Cloud.
//
// Best-effort: si falla, el dispatcher registra el error en raw_events.error.
// Sólo se ejecuta para inboxes ruteados a "antonia".

const TIMEOUT_MS = Number(process.env.ANTONIA_BRIDGE_TIMEOUT_MS || 8000);

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
  } finally {
    clearTimeout(timer);
  }
}
