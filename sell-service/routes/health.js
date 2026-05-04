import { Router } from "express";
import { frappe } from "../lib/frappe-client.js";

const router = Router();

router.get("/", async (_req, res) => {
  const out = {
    status: "ok",
    module: "sell-service",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    frappe: "unknown",
  };

  try {
    const r = await frappe.get(
      "/api/method/frappe.auth.get_logged_user"
    );
    out.frappe = "ok";
    out.frappe_user = r?.message;
  } catch (err) {
    out.frappe = "error";
    out.frappe_error = err.message;
  }

  res.json(out);
});

export default router;
