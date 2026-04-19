// Cliente HTTP mínimo para Zendesk Support API con:
// - Auth por email/token (Basic)
// - Manejo de rate limits (respeta Retry-After)
// - Helper para paginación

const REQUIRED_ENV = [
  "ZENDESK_SUBDOMAIN",
  "ZENDESK_EMAIL",
  "ZENDESK_API_TOKEN",
];

export function assertCredentials() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing Zendesk credentials: ${missing.join(", ")}. ` +
        "Set them as env vars on Render."
    );
  }
}

function baseUrl() {
  return `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com`;
}

function authHeader() {
  const token = Buffer.from(
    `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
  ).toString("base64");
  return `Basic ${token}`;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function zdFetch(pathOrUrl, { retries = 3 } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${baseUrl()}${pathOrUrl}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get("retry-after") || "10");
      console.log(
        `[zendesk] ${res.status} on ${url.split("?")[0]}, waiting ${retryAfter}s (attempt ${attempt + 1})`
      );
      await wait(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      if (attempt < retries && res.status >= 500) {
        const backoff = 2 ** attempt * 1000;
        console.log(`[zendesk] ${res.status} transient, retry in ${backoff}ms`);
        await wait(backoff);
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`Zendesk ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }

    return res.json();
  }
}

// Itera sobre un endpoint paginado. Soporta both: `next_page` (legacy) y
// `links.next` + `meta.after_cursor` (cursor-based).
export async function* zdPaginate(initialPath, itemsKey) {
  let url = initialPath;
  while (url) {
    const data = await zdFetch(url);
    const items = data[itemsKey] || data.results || [];
    for (const item of items) yield item;
    url = data.next_page || data.links?.next || null;
  }
}
