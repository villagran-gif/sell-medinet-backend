// Entry point para correr migraciones a mano:
//   node support-service/migrations/cli.js
// o vía npm: `npm run migrate:support`

import { runMigrations } from "./runner.js";
import { closePool } from "../db.js";

(async () => {
  try {
    const applied = await runMigrations();
    if (applied.length === 0) {
      console.log("[support-service] migrations: nothing to apply");
    } else {
      console.log(`[support-service] migrations applied: ${applied.join(", ")}`);
    }
  } catch (err) {
    console.error("[support-service] migration failed:", err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
})();
