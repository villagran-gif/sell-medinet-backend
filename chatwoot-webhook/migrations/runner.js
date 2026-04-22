import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool } from "../db.js";

const migrationsDir = dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  const pool = getPool();
  await pool.query("CREATE SCHEMA IF NOT EXISTS chatwoot");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chatwoot.migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = [];
  for (const file of files) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM chatwoot.migrations WHERE name = $1",
      [file]
    );
    if (rowCount > 0) continue;

    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO chatwoot.migrations (name) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}
