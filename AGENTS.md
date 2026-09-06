# AGENTS.md

## Contexto

Backend Node.js + Express (ESM, Node >=18) desplegado en Render. Actúa como **gateway de integración** entre Chatwoot, Clínyco AI/AntonIA, Medinet, Twilio y automatizaciones operacionales.

## Reglas

1. Preservar contratos públicos existentes (`/medinet/*`, `/chatwoot-webhook/*`, `/confirmations/*`).
2. Módulos nuevos: carpeta autocontenida + montaje explícito en `server.js`.
3. PostgreSQL: schemas separados y migraciones idempotentes.
4. Secretos sólo en variables de entorno; nunca en Git.
5. CI debe pasar antes de merge.
6. Producción se despliega de forma deliberada; un merge no implica asumir que Render ya ejecuta ese commit.
7. No reintroducir dependencias de Frappe, Zendesk Sell, Zendesk Support ni Sunshine Conversations.

## Arquitectura

Chatwoot -> webhook durable -> `chatwoot.raw_events` -> dispatcher -> `antonia` / `melania`.
