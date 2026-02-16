# sell-medinet-backend

Backend mínimo en Node.js + Express para conectar Zendesk Sell con Medinet mediante endpoints protegidos por API key.

## Qué hace este servicio

- Expone `GET /` para validar que el backend está activo.
- Expone `POST /medinet/import` para recibir datos JSON.
- Expone `POST /medinet/search` para preparar búsquedas por identificador (`DNI` o `RUN`).
- Protege endpoints con header `X-API-Key` contra la variable de entorno `API_KEY`.
- Para `RUN`, acepta entrada “humana” (con puntos/guion), **valida DV chileno (módulo 11)** y responde tanto en formato UX como normalizado.

---

## Requisitos

- Node.js **>= 18** (ver `"engines"` en `package.json`)

---

## Variables de entorno

- `API_KEY` (**obligatoria**) — clave que debe venir en el header `X-API-Key`.
- `PORT` (opcional en local). En Render normalmente viene definida automáticamente.

Ejemplo local:
```bash
export API_KEY="tu_api_key"
export PORT=3000
