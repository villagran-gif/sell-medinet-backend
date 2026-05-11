import { Router } from "express";
import { getPool } from "../db.js";

const router = Router();

router.get("/", async (_req, res) => {
  const out = { status: "ok", module: "confirmations", db: "unknown" };
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM confirmations.appointments"
    );
    out.db = "ok";
    out.appointments_count = rows[0].n;
  } catch (err) {
    out.db = "error";
    out.db_error = err.message;
  }
  res.json(out);
});

export default router;
