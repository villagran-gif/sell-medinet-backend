# antonia-bridge

Handler del `chatwoot-dispatcher` que entrega eventos `message_created` de Chatwoot al core de Clínyco AI.

## Flujo

```text
Chatwoot
  -> chatwoot-webhook
  -> chatwoot.raw_events
  -> chatwoot-dispatcher
  -> antonia-bridge
  -> clinyco_AI POST /chatwoot/inbound
  -> AntonIA
  -> Chatwoot API
```

## Variables

- `CLINYCO_AI_BASE_URL`
- `CHATWOOT_ADAPTER_TOKEN`
- `ANTONIA_BRIDGE_TIMEOUT_MS` (default 8000)

El bridge reenvía el payload crudo para que `clinyco_AI` aplique su parser de Chatwoot y su lógica conversacional.
