# tiktok-bridge

Middleware to relay messages between TikTok (gateway: ManyChat) and a Chatwoot **API channel** inbox.

## Architecture

```
[TikTok user]  ⇄  [ManyChat]  ⇄  this bridge  ⇄  [Chatwoot inbox API]
```

ManyChat is the certified TikTok partner. Inbound is Flow-driven (External Request); outbound is REST.

## Mount in `server.js` (already wired, opt-in)

Mounted at `/webhooks` when `TIKTOK_BRIDGE_ENABLED=true`.

## Endpoints (when enabled)

- `POST /webhooks/tiktok` — ManyChat External Request → Chatwoot incoming
- `POST /webhooks/chatwoot/tiktok` — Chatwoot agent reply → ManyChat → TikTok

## ManyChat Flow setup

1. Settings → Apps → connect TikTok Business account.
2. Automation → New Flow → Trigger: Default Reply (TikTok channel) or catch-all keyword.
3. Action **External Request**:
   - Method: `POST`
   - URL: `https://<this-render-service>.onrender.com/webhooks/tiktok`
   - Headers:
     - `X-Bridge-Secret: <MANYCHAT_WEBHOOK_SECRET>`
     - `Content-Type: application/json`
   - Body (JSON):
     ```json
     {
       "subscriber_id": "{{user_id}}",
       "name": "{{first_name}} {{last_name}}",
       "text": "{{last_input_text}}",
       "channel": "tiktok"
     }
     ```

## Chatwoot side

Update the API inbox (`107767` / `iNxtMRQ68ef6bLRZ7EkkuSWx`) `webhook_url` to `https://<this-render-service>.onrender.com/webhooks/chatwoot/tiktok`.

## Required env

- `TIKTOK_BRIDGE_ENABLED=true` to mount the router
- `CHATWOOT_BASE_URL` (default `https://app.chatwoot.com`)
- `CHATWOOT_TIKTOK_INBOX_IDENTIFIER=iNxtMRQ68ef6bLRZ7EkkuSWx`
- `MANYCHAT_API_KEY` — from ManyChat Settings → API (PRO plan required)
- `MANYCHAT_WEBHOOK_SECRET` (optional but recommended) — shared secret for the External Request header

## TODO before production

- HMAC verification of Chatwoot webhook (`X-Chatwoot-Hmac-Sha256`) using inbox `hmac_token`.
- Persist mapping `subscriber_id ↔ chatwoot conversation_id` if the public API stops returning it.
- Handle attachments (images) in both directions.
- One ManyChat workspace = one TikTok page — replicate or parameterize for multi-account.
