# CLAUDE.md — Instrucciones para Claude Code

## Contexto del repo
Backend Node.js + Express que conecta Zendesk Sell con Medinet.

- Render service: `srv-d68hpvoboq4c73d368k0`
- URL prod: https://sell-medinet-backend.onrender.com
- Comparte Postgres (`clinyco-db` en Render) con el proyecto `clinyco_ai`.
- `server.js` es el único archivo de runtime. Tamaño chico, preservar su superficie.

## Rol de este repo en la arquitectura
Hospeda, además de la integración Medinet actual, el **módulo satélite de soporte**
que reemplaza Zendesk Support de forma progresiva (strangler fig).
No duplicamos servicios Render: absorbemos el módulo aquí para evitar costo extra.

## Convenciones de ramas
- `claude/<slug>` — ramas de Claude Code
- `codex/<slug>` — ramas de Codex
- `human/<slug>` — ramas manuales
- `main` — solo merges vía PR, nunca push directo

## Reglas duras
1. No modificar los endpoints existentes (`/`, `/medinet/*`) salvo orden explícita.
2. Módulos nuevos viven en carpetas autocontenidas (ej: `support-service/`).
   Se montan con `app.use('/prefix', router)` en `server.js` — 1 sola línea de cambio.
3. Postgres: usar schemas separados (`support.*`) y usuarios dedicados con
   permisos acotados. Migraciones DDL se corren solo desde los dueños del schema.
4. Secretos: jamás en el repo. `.env` gitignored. Todo en Render env vars.
5. Cambios a `.github/`, `render.yaml`, `CODEOWNERS`, `CLAUDE.md`, `AGENTS.md`
   requieren review humano (CODEOWNERS los protege).
6. CI debe pasar antes de merge.
7. Auto-deploy de producción está **apagado** en Render. Deploys son manuales.

## Comandos permitidos
- `npm install`, `npm ci`, `npm start`, `npm run dev`
- `node --check server.js` (validación de sintaxis)
- `git` (excepto operaciones destructivas sin consentimiento)

## Flujo de PR
1. Crear rama desde `main` con prefijo `claude/`.
2. Commits pequeños, mensajes claros en español.
3. Abrir PR con el template (`.github/PULL_REQUEST_TEMPLATE.md`).
4. Esperar CI verde + review.
5. Merge → el responsable humano decide cuándo hacer deploy manual en Render.

## Antipatrones a evitar
- Agregar dependencias "por si acaso". Justificar cada una.
- Romper el contrato de los endpoints actuales (headers, payloads).
- Tocar `render.yaml` o CI sin acuerdo previo.
- Crear servicios Render nuevos (cuesta). Reciclar lo que ya está pagado.
