# CLAUDE.md

## Contexto del repositorio

Este servicio es el **Clínyco Integration Gateway**. El nombre histórico del repo se conserva para no romper URLs/infraestructura, pero su responsabilidad actual es recibir, persistir y enrutar eventos e integraciones.

### Runtime activo

- Chatwoot webhook ingestion.
- Dispatcher hacia AntonIA y MelanIA.
- Confirmaciones de citas Medinet.
- Bridge Medinet.
- Twilio/voz/transcripción.
- TikTok bridge cuando corresponda.

### Sistemas retirados

No reintroducir código de runtime ni dependencias para:

- Frappe/FCRM.
- Zendesk Sell.
- Zendesk Support.
- Sunshine Conversations.

## Producción

- Render service histórico: `sell-medinet-backend`.
- Comparte PostgreSQL con `clinyco_AI` para los schemas operacionales que correspondan.
- Secretos: sólo variables de entorno.

## Reglas duras

1. No romper `/medinet/*` ni los endpoints Chatwoot/confirmations activos.
2. Cambios pequeños, aislados y testeables.
3. PostgreSQL con migraciones idempotentes.
4. Nunca guardar credenciales ni respaldos de pacientes en Git.
5. CI verde antes de merge.
6. No asumir que merge = deploy.
