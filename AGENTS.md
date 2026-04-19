# AGENTS.md — Instrucciones para Codex

## Contexto
Backend Node.js + Express (ESM, Node >=18). Conecta Zendesk Sell con Medinet.
Deploy: Render (`sell-medinet-backend.onrender.com`). Comparte Postgres con `clinyco_ai`.

Este repo también aloja el **módulo de soporte** que reemplaza Zendesk Support
de forma incremental. Se monta como router Express en `server.js`.

## Ramas
- `codex/<slug>` — tus ramas.
- `claude/<slug>` — ramas de Claude Code (no pisarlas).
- `main` — solo merges vía PR.

## Reglas
1. No cambiar endpoints existentes sin ticket claro.
2. Módulos nuevos: carpeta autocontenida + `app.use('/prefix', router)`.
3. Postgres: schemas separados, usuarios dedicados.
4. Secretos nunca en repo (`.env` gitignored).
5. `.github/`, `render.yaml`, `CODEOWNERS`, `CLAUDE.md`, `AGENTS.md`
   requieren approval humana (CODEOWNERS).
6. CI verde antes de merge.

## Comandos
- `npm install`, `npm start`, `npm run dev`
- `node --check server.js`

## Style
- ESM (`import/export`), no CommonJS.
- Manejo de errores explícito en handlers Express.
- Validación de input en boundaries (headers, body).
- Sin dependencias nuevas sin justificación.

## PRs
Usar `.github/PULL_REQUEST_TEMPLATE.md`. Commits chicos, reversibles.
Explicar el "por qué" en la descripción del PR.
