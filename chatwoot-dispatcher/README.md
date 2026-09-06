# chatwoot-dispatcher

Consumidor central de `chatwoot.raw_events` para eventos `message_created`.

## Responsabilidad

Reclama cada evento una sola vez con `FOR UPDATE SKIP LOCKED` y lo enruta según `inbox_id` a los handlers activos:

- `antonia` → reenvía el payload a `clinyco_AI /chatwoot/inbound`.
- `melania` → procesa confirmaciones de citas.

## Configuración

- `CHATWOOT_DISPATCH_ROUTES`: JSON de inbox → handlers.
- `CHATWOOT_DISPATCH_DEFAULT`: handlers por defecto; si no se define, usa `melania`.

Ejemplo:

```text
CHATWOOT_DISPATCH_ROUTES={"107690":["antonia"],"107691":["melania"]}
```

No existen handlers de Frappe, Zendesk Support ni Zendesk Sell en este dispatcher.
