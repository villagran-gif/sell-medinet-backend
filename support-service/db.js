import pg from "pg";

let pool = null;

function resolveConnectionString() {
  return (
    process.env.SUPPORT_DATABASE_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

function resolveSsl(connectionString) {
  if (!connectionString) return undefined;
  const looksManaged =
    /render\.com/.test(connectionString) ||
    /\.oregon-postgres\./.test(connectionString) ||
    /\.amazonaws\.com/.test(connectionString);
  const forced =
    process.env.PGSSLMODE === "require" ||
    process.env.SUPPORT_DB_SSL === "true";
  return looksManaged || forced ? { rejectUnauthorized: false } : undefined;
}

export function getPool() {
  if (pool) return pool;

  const connectionString = resolveConnectionString();
  if (!connectionString) {
    throw new Error(
      "support-service: SUPPORT_DATABASE_URL (or DATABASE_URL) is not set"
    );
  }

  pool = new pg.Pool({
    connectionString,
    ssl: resolveSsl(connectionString),
    max: Number(process.env.SUPPORT_DB_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    console.error("[support-service] pg pool error:", err);
  });

  return pool;
}

export async function pingDb() {
  const { rows } = await getPool().query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}
