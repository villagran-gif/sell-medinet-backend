// support-normalizer/index.js
//
// Handler del chatwoot-dispatcher que espeja conversaciones de Chatwoot Cloud
// (cuenta 162472) a `support.*`, en shape Zendesk — que es lo que sirve el
// satélite support-service. Así, cuando se flipee SUPPORT_BACKEND=satellite en
// clinyco_AI, el satélite refleja Chatwoot y no solo el backfill de Zendesk.
//
// DORMANT por default: el dispatcher solo invoca este handler para inboxes
// ruteados explícitamente a "support-normalizer" (ver chatwoot-dispatcher).

import { mapMessageCreated } from "./map.js";
import { mirrorMessage } from "./db.js";

// ev = { id, event_type, payload }
export async function handleInboundEvent(ev) {
  const mapped = mapMessageCreated(ev?.payload);
  if (!mapped) return { skipped: true };
  const { userId, ticketId } = await mirrorMessage(mapped);
  return { mirrored: true, userId, ticketId };
}
