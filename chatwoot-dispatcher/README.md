# chatwoot-dispatcher

Consumidor central de `chatwoot.raw_events` para eventos `message_created`.

## Responsabilidad

Reclama cada evento una sola vez con `FOR UPDATE SKIP LOCKED` y lo entrega a:

- `antonia` → reenvía el payload a `clinyco_AI /chatwoot/inbound`.

El antiguo handler de confirmaciones ya no participa del flujo conversacional de Chatwoot.

## Arquitectura vigente

```text
Chatwoot → sell-medinet-backend → AntonIA
                                 ↓
                    cuando corresponde agendar
                                 ↓
                       MelanIA / Medinet
```

MelanIA sólo es utilizada desde `clinyco_AI` cuando AntonIA necesita consultar disponibilidad real en Medinet. No consume mensajes del inbox de forma paralela.

## Configuración

El dispatcher sólo acepta `antonia`. Configuraciones antiguas que incluyan `melania` se ignoran por seguridad.

Configuración recomendada en Render:

```text
CHATWOOT_DISPATCH_DEFAULT=antonia
CHATWOOT_DISPATCH_ROUTES={"107690":["antonia"]}
CONFIRMATIONS_ENABLED=false
```

No existen handlers activos de Frappe, Zendesk Support, Zendesk Sell ni confirmaciones en este dispatcher.
