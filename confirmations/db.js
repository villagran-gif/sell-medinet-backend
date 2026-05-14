import pg from "pg";

let pool = null;

function resolveConnectionString() {
  return (
    process.env.CONFIRMATIONS_DATABASE_URL ||
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
    process.env.CONFIRMATIONS_DB_SSL === "true";
  return looksManaged || forced ? { rejectUnauthorized: false } : undefined;
}

export function getPool() {
  if (pool) return pool;

  const connectionString = resolveConnectionString();
  if (!connectionString) {
    throw new Error(
      "confirmations: falta CONFIRMATIONS_DATABASE_URL o DATABASE_URL"
    );
  }

  pool = new pg.Pool({
    connectionString,
    ssl: resolveSsl(connectionString),
    max: Number(process.env.CONFIRMATIONS_DB_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
  });

  return pool;
}
