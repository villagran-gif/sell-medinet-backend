// chatwoot-dispatcher/routing.js
//
// Lógica de ruteo pura: dado un payload de Chatwoot, decide qué handlers lo
// procesan. Sin DB ni side-effects — testeable en aislamiento.
//
// Config por env:
//   CHATWOOT_DISPATCH_ROUTES   JSON { "<inbox_id>": ["melania"], "107690": ["support-normalizer","melania"] }
//   CHATWOOT_DISPATCH_DEFAULT  lista separada por comas (default "melania")
//
// Default (sin env): TODO va a "melania" → comportamiento idéntico al previo
// a este módulo. Los handlers nuevos solo corren cuando un inbox se rutea
// explícitamente a ellos.

export const DEFAULT_HANDLER = "melania";

// Chatwoot Cloud expone el inbox en distintos lugares según el evento;
// probamos en orden de preferencia.
export function extractInboxId(payload) {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [
    payload.inbox?.id,
    payload.conversation?.inbox_id,
    payload.conversation?.inbox?.id,
    payload.conversation?.meta?.inbox_id,
    payload.contact_inbox?.inbox_id,
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== "") {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function normalizeKeys(value) {
  const arr = Array.isArray(value) ? value : String(value).split(",");
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

export function parseRoutingConfig(env = process.env) {
  const routes = {};
  const raw = env.CHATWOOT_DISPATCH_ROUTES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          const keys = normalizeKeys(v);
          if (keys.length) routes[String(k)] = keys;
        }
      }
    } catch (err) {
      console.error(
        "[chatwoot-dispatcher] CHATWOOT_DISPATCH_ROUTES inválido, se ignora:",
        err.message
      );
    }
  }

  let defaultKeys = env.CHATWOOT_DISPATCH_DEFAULT
    ? normalizeKeys(env.CHATWOOT_DISPATCH_DEFAULT)
    : [DEFAULT_HANDLER];
  if (!defaultKeys.length) defaultKeys = [DEFAULT_HANDLER];

  return { routes, defaultKeys };
}

// Resuelve los handler keys para un payload dado la config ya parseada.
export function resolveHandlerKeys(payload, config) {
  const { routes, defaultKeys } = config;
  const inboxId = extractInboxId(payload);
  if (inboxId != null && routes[String(inboxId)]) {
    return routes[String(inboxId)];
  }
  return defaultKeys;
}
