# sell-medinet-backend

Backend mínimo en Node.js + Express para conectar Zendesk Sell con Medinet mediante un endpoint protegido por API key.

## Qué hace este servicio

- Expone `GET /` para validar que el backend está activo.
- Expone `POST /medinet/import` para recibir datos JSON.
- Valida el header `X-API-Key` contra la variable de entorno `API_KEY`.

## Endpoints

### `GET /`
Responde texto:

```text
OK - sell-medinet-backend
```

### `POST /medinet/import`

- Requiere header: `X-API-Key: <API_KEY>`
- Requiere body JSON

Respuestas posibles:

- `500` si falta `API_KEY` en el entorno:

```json
{ "status": "error", "message": "Backend sin API_KEY configurada en Render (Environment)." }
```

- `401` si `X-API-Key` no coincide:

```json
{ "status": "error", "message": "API key inválida" }
```

- `200` si todo está correcto:

```json
{
  "status": "ok",
  "message": "Conectado ✅ (backend Render)",
  "received": { "...": "body recibido" }
}
```

## Configuración

1. Instalar dependencias:

```bash
npm install
```

2. Definir variables de entorno:

```bash
export API_KEY="tu_api_key"
export PORT=3000
```

3. Ejecutar el servidor:

```bash
npm start
```

## Ejemplo `curl`

```bash
curl -X POST http://localhost:3000/medinet/import \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu_api_key" \
  -d '{"contacto":"Juan Pérez","telefono":"555-1234"}'
```

## Deploy en Render

- Tipo de servicio: **Web Service (Node)**
- Start command: `npm start`
- En Render se debe configurar la Environment Variable:
  - `API_KEY`
