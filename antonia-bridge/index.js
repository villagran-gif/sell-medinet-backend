// antonia-bridge/index.js
//
// Handler del chatwoot-dispatcher que reenvía un `message_created` a clinyco_AI
// para que el cerebro de Antonia responda por Chatwoot Cloud. clinyco_AI expone
// `POST /chatwoot/inbound` (ver módulo chatwoot-adapter en ese repo), que corre
// la misma lógica que el webhook Sunco `/messages`.
//
// Best-effort: si falla, el dispatcher registra el error en raw_events.error.
// Dormant salvo que un inbox se rutee a "antonia" en el dispatcher.

const TIMEOUT_MS = Number(process.env.ANTONIA_BRIDGE_TIMEOUT_MS || 8000);

// ev = { id, event_type, payload }
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
      // Reenviamos el payload crudo de Chatwoot; clinyco_AI lo detecta y
      // normaliza (extractConversationInfo → parseChatwootInbound).
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
