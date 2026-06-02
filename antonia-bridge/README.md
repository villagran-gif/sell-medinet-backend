# antonia-bridge

Handler del `chatwoot-dispatcher` (key `antonia`) que **reenvía un `message_created`
a clinyco_AI** para que el cerebro de Antonia responda por Chatwoot Cloud.

## Flujo

```
chatwoot.raw_events ─→ chatwoot-dispatcher (inbox ruteado a "antonia")
                          └─ antonia-bridge.handleInboundEvent(ev)
                               └─HTTP POST $CLINYCO_AI_BASE_URL/chatwoot/inbound
                                    (Bearer $CHATWOOT_ADAPTER_TOKEN, body = ev.payload crudo)
```

clinyco_AI expone `POST /chatwoot/inbound` (módulo `chatwoot-adapter` en ese repo),
que detecta el payload de Chatwoot, lo normaliza al mismo `info` que Sunco y corre
la misma lógica que `/messages`. Antonia responde vía la API de Chatwoot.

Reenviamos el **payload crudo** (no normalizado) porque clinyco_AI ya sabe
interpretarlo — así el contrato entre repos es simplemente "el webhook de Chatwoot".

## Env

| Var | Requerida | Para qué |
|---|---|---|
| `CLINYCO_AI_BASE_URL` | sí | Base del VPS clinyco_AI (se le agrega `/chatwoot/inbound`). |
| `CHATWOOT_ADAPTER_TOKEN` | sí | Bearer; mismo valor que el `CHATWOOT_ADAPTER_TOKEN` de clinyco_AI. |
| `ANTONIA_BRIDGE_TIMEOUT_MS` | no (8000) | Timeout del forward. |

Si falta `CLINYCO_AI_BASE_URL`/`CHATWOOT_ADAPTER_TOKEN`, el handler hace skip
(no rompe el dispatcher). Best-effort: un fallo se registra en `raw_events.error`.

## Activación

Dormant hasta rutear un inbox a `antonia` en el dispatcher:

```
CHATWOOT_DISPATCH_ROUTES={"<inbox_id>":["antonia"]}
```

Se puede combinar: `{"<inbox_id>":["support-normalizer","antonia"]}` espeja a
`support.*` **y** deja que Antonia responda, del mismo evento.
