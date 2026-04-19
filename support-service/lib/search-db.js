// Búsquedas compartidas entre /users/search y /search (global).
// Parsea filtros del DSL de Zendesk y ejecuta queries Postgres acotadas.

import { getPool } from "../db.js";

const MAX_LIMIT = 100;

function firstValue(filters, key) {
  return filters[key]?.[0];
}

export async function searchUsers({ filters, freeTerms }) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (filters.email) {
    conditions.push(`lower(email) = $${i++}`);
    values.push(String(firstValue(filters, "email")).toLowerCase());
  }
  if (filters.phone) {
    conditions.push(`phone = $${i++}`);
    values.push(String(firstValue(filters, "phone")));
  }
  if (filters.name) {
    conditions.push(`name ILIKE $${i++}`);
    values.push(`%${firstValue(filters, "name")}%`);
  }
  if (filters.external_id) {
    conditions.push(`external_id = $${i++}`);
    values.push(String(firstValue(filters, "external_id")));
  }
  if (filters.role) {
    conditions.push(`role = $${i++}`);
    values.push(String(firstValue(filters, "role")));
  }

  for (const term of freeTerms) {
    conditions.push(
      `(lower(email) LIKE $${i} OR lower(name) LIKE $${i} OR phone LIKE $${i})`
    );
    values.push(`%${String(term).toLowerCase()}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await getPool().query(
    `SELECT * FROM support.users ${where} ORDER BY id LIMIT ${MAX_LIMIT}`,
    values
  );
  return rows;
}

export async function searchTickets({ filters, freeTerms }) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (filters.status) {
    conditions.push(`status = ANY($${i++}::text[])`);
    values.push(filters.status.map(String));
  }
  if (filters.priority) {
    conditions.push(`priority = ANY($${i++}::text[])`);
    values.push(filters.priority.map(String));
  }
  if (filters.requester_id) {
    conditions.push(`requester_id = $${i++}`);
    values.push(Number(firstValue(filters, "requester_id")));
  }
  if (filters.assignee_id) {
    conditions.push(`assignee_id = $${i++}`);
    values.push(Number(firstValue(filters, "assignee_id")));
  }
  if (filters.external_id) {
    conditions.push(`external_id = $${i++}`);
    values.push(String(firstValue(filters, "external_id")));
  }
  if (filters.tags) {
    conditions.push(`tags && $${i++}::text[]`);
    values.push(filters.tags.map(String));
  }

  for (const term of freeTerms) {
    conditions.push(`(subject ILIKE $${i} OR description ILIKE $${i})`);
    values.push(`%${term}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await getPool().query(
    `SELECT * FROM support.tickets ${where} ORDER BY id LIMIT ${MAX_LIMIT}`,
    values
  );
  return rows;
}
