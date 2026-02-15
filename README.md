# sell-medinet-backend

Backend mínimo en Node.js + Express para conectar Zendesk Sell con Medinet mediante endpoints protegidos por API key.

## Qué hace este servicio

- Expone `GET /` para validar que el backend está activo.
- Expone `POST /medinet/import` para recibir datos JSON.
- Expone `POST /medinet/search` para búsquedas por identificador con tipo de documento (`DNI` o `RUN`) y normalización del valor.
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

- `500` si falta `API_KEY` en el entorno.
- `401` si `X-API-Key` no coincide.
- `200` si todo está correcto (devuelve el body recibido).

### `POST /medinet/search`

- Requiere header: `X-API-Key: <API_KEY>`
- Requiere body JSON con:
  - `identifierType`: `DNI` o `RUN`
  - `identifierValue`: valor ingresado por usuario

Normalización aplicada:

- `DNI`: se envía solo dígitos.
- `RUN`: se quitan puntos, se fuerza `K` mayúscula y se conserva guion si viene informado.

Respuestas posibles:

- `400` si `identifierType` no es válido.
- `400` si falta `identifierValue`.
- `500` si falta `API_KEY` en el entorno.
- `401` si `X-API-Key` no coincide.
- `200` si todo está correcto (incluye `search.identifierType` y `search.identifierValue` normalizados).

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

## Ejemplo `curl` - búsqueda DNI

```bash
curl -X POST http://localhost:3000/medinet/search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu_api_key" \
  -d '{"identifierType":"DNI","identifierValue":"12.345.678"}'
```

## Ejemplo `curl` - búsqueda RUN

```bash
curl -X POST http://localhost:3000/medinet/search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: tu_api_key" \
  -d '{"identifierType":"RUN","identifierValue":"12.345.678-k"}'
```

## Deploy en Render

- Tipo de servicio: **Web Service (Node)**
- Start command: `npm start`
- En Render se debe configurar la Environment Variable:
  - `API_KEY`
