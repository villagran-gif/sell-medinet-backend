/**
 * Cliente HTTP para Frappe Cloud REST API.
 *
 * Usa global fetch (Node 18+).
 * Auth: API Key + Secret en header `Authorization: token <key>:<secret>`.
 * Site URL configurada via `FRAPPE_SITE_URL`.
 */

function authHeader() {
  const key = process.env.FRAPPE_API_KEY;
  const secret = process.env.FRAPPE_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      "sell-service: faltan FRAPPE_API_KEY y/o FRAPPE_API_SECRET en env"
    );
  }
  return `token ${key}:${secret}`;
}

function siteUrl() {
  const url = process.env.FRAPPE_SITE_URL;
  if (!url) throw new Error("sell-service: falta FRAPPE_SITE_URL en env");
  return url.replace(/\/$/, "");
}

async function frappeRequest(method, path, body) {
  const url = `${siteUrl()}${path}`;
  const headers = {
    Authorization: authHeader(),
    "Content-Type": "application/json",
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(
      `Frappe API ${method} ${path} → ${res.status}: ${
        data?.exception || data?.message || text.slice(0, 200)
      }`
    );
    err.status = res.status;
    err.frappeData = data;
    throw err;
  }
  return data;
}

export const frappe = {
  get: (path) => frappeRequest("GET", path),
  post: (path, body) => frappeRequest("POST", path, body),
  put: (path, body) => frappeRequest("PUT", path, body),
  delete: (path) => frappeRequest("DELETE", path),

  // Helpers semánticos
  getList: async (doctype, { filters, fields, limit = 100, page = 1 } = {}) => {
    const params = new URLSearchParams({
      doctype,
      limit_page_length: String(limit),
      limit_start: String((page - 1) * limit),
    });
    if (fields) params.set("fields", JSON.stringify(fields));
    if (filters) params.set("filters", JSON.stringify(filters));
    const res = await frappeRequest(
      "GET",
      `/api/method/frappe.client.get_list?${params.toString()}`
    );
    return res?.message || [];
  },

  getDoc: async (doctype, name) => {
    const enc = encodeURIComponent(doctype);
    const ename = encodeURIComponent(name);
    const res = await frappeRequest("GET", `/api/resource/${enc}/${ename}`);
    return res?.data;
  },

  insert: async (doctype, doc) => {
    const res = await frappeRequest("POST", "/api/method/frappe.client.insert", {
      doc: { doctype, ...doc },
    });
    return res?.message;
  },

  update: async (doctype, name, fields) => {
    // Use frappe.client.set_value para single-field updates
    // o PUT /api/resource/<doctype>/<name> para multiple
    const enc = encodeURIComponent(doctype);
    const ename = encodeURIComponent(name);
    const res = await frappeRequest("PUT", `/api/resource/${enc}/${ename}`, fields);
    return res?.data;
  },

  count: async (doctype, filters) => {
    const params = new URLSearchParams({ doctype });
    if (filters) params.set("filters", JSON.stringify(filters));
    const res = await frappeRequest(
      "GET",
      `/api/method/frappe.client.get_count?${params.toString()}`
    );
    return res?.message || 0;
  },
};
