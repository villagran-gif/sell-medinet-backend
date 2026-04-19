## Qué cambia
<!-- 1-3 bullets concretos. Qué código se modifica y qué comportamiento cambia. -->

## Por qué
<!-- Motivación / problema que resuelve. -->

## Tipo de cambio
- [ ] Feature nueva (módulo o endpoint)
- [ ] Fix de bug
- [ ] Refactor (sin cambio de comportamiento)
- [ ] Docs / gobierno (CLAUDE.md, AGENTS.md, CODEOWNERS, README)
- [ ] Infra (CI, render.yaml, dependencias)

## Checklist
- [ ] La rama sigue convención (`claude/…`, `codex/…`, `human/…`).
- [ ] No introduce secretos ni toca `.env`.
- [ ] Endpoints existentes (`/`, `/medinet/*`) siguen respondiendo igual.
- [ ] Si agrega dependencias, justificadas en la descripción.
- [ ] `node --check server.js` pasa localmente.
- [ ] Si afecta DB: migración incluida, reversible, schema correcto (`support.*` vs `public.*`).
- [ ] CI verde.

## Rollback plan
<!-- Cómo revertir si algo sale mal en prod. Ej: "revert del commit + redeploy manual". -->

## Notas de deploy
<!-- ¿Requiere env vars nuevas? ¿Migración de DB previa? ¿Orden de despliegue? -->
