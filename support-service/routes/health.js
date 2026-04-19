import { Router } from "express";
import { pingDb } from "../db.js";
import { asyncHandler } from "../lib/errors.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    let dbOk = false;
    let dbError = null;
    try {
      dbOk = await pingDb();
    } catch (err) {
      dbError = err.message;
    }
    res.status(dbOk ? 200 : 503).json({
      service: "support-service",
      db: dbOk ? "ok" : "down",
      db_error: dbError,
      time: new Date().toISOString(),
    });
  })
);

export default router;
