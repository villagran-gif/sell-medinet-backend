import { Router } from "express";
import { requireBearer } from "../lib/auth.js";
import { upsertAppointment, validateIntakePayload } from "../lifecycle.js";

const router = Router();

/**
 * POST /confirmations/intake
 *
 * Endpoint principal de entrada de citas. Lo invoca clinyco_AI desde el
 * VPS chileno (único que puede hablar con Medinet por geo-block) cuando
 * su poller detecta una cita nueva o actualizada.
 *
 * Auth: Bearer CONFIRMATIONS_INTAKE_TOKEN.
 *
 * Body esperado (contrato — ver confirmations/README.md):
 *   {
 *     "external_id": 414088,                       // Medinet appointment id
 *     "branch_id": 2,
 *     "branch_name": "Telemedicina Área Médica",
 *     "specialty": "Medicina General",
 *     "professional": "Dra. Foo Bar",
 *     "appointment_at": "2026-05-11T17:30:00-04:00",
 *     "duration_min": 40,
 *     "medinet_state": "Confirmado",
 *     "patient": {
 *       "run": "12345678-9",
 *       "name": "Juan Pérez",
 *       "phone": "+56912345678",
 *       "email": "..."
 *     },
 *     "raw": { ... }   // opcional, payload Medinet original
 *   }
 *
 * Idempotente: reenvíos de la misma cita actualizan sin duplicar ni
 * resetear estado. Útil porque clinyco_AI polea Medinet cada 5 min.
 */
router.post("/", requireBearer, async (req, res) => {
  let normalized;
  try {
    normalized = validateIntakePayload(req.body);
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({
        error: "invalid_payload",
        field: err.field,
        message: err.message,
      });
    }
    throw err;
  }

  try {
    const { row, created } = await upsertAppointment(normalized);
    return res.status(created ? 201 : 200).json({
      status: "ok",
      created,
      appointment: {
        id: row.id,
        external_id: row.external_id,
        state: row.state,
      },
    });
  } catch (err) {
    console.error("[confirmations/intake] db_error:", err.message);
    return res.status(500).json({
      error: "db_error",
      message: err.message,
    });
  }
});

export default router;
