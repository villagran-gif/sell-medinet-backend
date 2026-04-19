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

export function mapTicketToZendesk(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    external_id: row.external_id,
    requester_id: row.requester_id != null ? Number(row.requester_id) : null,
    assignee_id: row.assignee_id != null ? Number(row.assignee_id) : null,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    via: { channel: row.channel ?? "api" },
    tags: row.tags ?? [],
    custom_fields: row.custom_fields ?? {},
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
  };
}

export function mapEventToZendesk(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    body: row.body,
    html_body: row.html_body,
    plain_body: row.plain_body,
    public: row.is_public,
    ...(row.payload ?? {}),
  };
}

export function mapAuditToZendesk(audit, events = []) {
  if (!audit) return null;
  return {
    id: Number(audit.id),
    ticket_id: Number(audit.ticket_id),
    author_id: audit.author_id != null ? Number(audit.author_id) : null,
    via: audit.via ?? {},
    metadata: audit.metadata ?? {},
    created_at: isoDate(audit.created_at),
    events: events.map(mapEventToZendesk),
  };
}
