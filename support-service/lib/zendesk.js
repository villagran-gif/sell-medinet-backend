// Convierte filas Postgres → payloads compatibles con Zendesk Support API.
// Objetivo: que clinyco_ai pueda apuntar su URL base aquí sin cambiar
// código de parsing.

function isoDate(value) {
  if (!value) return null;
  if (typeof value?.toISOString === "function") return value.toISOString();
  return value;
}

export function mapUserToZendesk(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    notes: row.notes,
    active: row.active,
    user_fields: row.user_fields ?? {},
    tags: row.tags ?? [],
    external_id: row.external_id,
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
  };
}

export function mapIdentityToZendesk(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    type: row.type,
    value: row.value,
    verified: row.verified,
    primary: row.is_primary,
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
  };
}
