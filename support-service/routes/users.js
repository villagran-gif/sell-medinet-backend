import { Router } from "express";
import { getPool } from "../db.js";
import { asyncHandler, HttpError } from "../lib/errors.js";
import { mapUserToZendesk, mapIdentityToZendesk } from "../lib/zendesk.js";

const router = Router();

const PATCHABLE_USER_COLUMNS = new Set([
  "name",
  "email",
  "phone",
  "notes",
  "role",
  "active",
  "external_id",
  "user_fields",
  "tags",
]);

function parseUserId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "invalid user id");
  }
  return id;
}

// GET /api/v2/users/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseUserId(req.params.id);
    const { rows } = await getPool().query(
      "SELECT * FROM support.users WHERE id = $1",
      [id]
    );
    if (rows.length === 0) throw new HttpError(404, "user not found");
    res.json({ user: mapUserToZendesk(rows[0]) });
  })
);

// PUT /api/v2/users/:id   body: { user: { ...patch } }
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseUserId(req.params.id);
    const patch = req.body?.user;
    if (!patch || typeof patch !== "object") {
      throw new HttpError(400, "missing user object in body");
    }

    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(patch)) {
      if (!PATCHABLE_USER_COLUMNS.has(key)) continue;
      sets.push(`${key} = $${i++}`);
      values.push(value);
    }
    if (sets.length === 0) {
      throw new HttpError(400, "no patchable fields provided");
    }
    values.push(id);
    const sql = `UPDATE support.users SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`;
    const { rows } = await getPool().query(sql, values);
    if (rows.length === 0) throw new HttpError(404, "user not found");
    res.json({ user: mapUserToZendesk(rows[0]) });
  })
);

// GET /api/v2/users/:id/identities
router.get(
  "/:id/identities",
  asyncHandler(async (req, res) => {
    const id = parseUserId(req.params.id);
    const { rows } = await getPool().query(
      "SELECT * FROM support.user_identities WHERE user_id = $1 ORDER BY id",
      [id]
    );
    res.json({
      identities: rows.map(mapIdentityToZendesk),
      count: rows.length,
      next_page: null,
      previous_page: null,
    });
  })
);

// POST /api/v2/users/:id/identities  body: { identity: { type, value, verified?, primary? } }
router.post(
  "/:id/identities",
  asyncHandler(async (req, res) => {
    const id = parseUserId(req.params.id);
    const identity = req.body?.identity;
    if (!identity?.type || !identity?.value) {
      throw new HttpError(400, "identity.type and identity.value are required");
    }

    const userExists = await getPool().query(
      "SELECT 1 FROM support.users WHERE id = $1",
      [id]
    );
    if (userExists.rowCount === 0) throw new HttpError(404, "user not found");

    try {
      const { rows } = await getPool().query(
        `INSERT INTO support.user_identities
           (user_id, type, value, verified, is_primary)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          id,
          String(identity.type),
          String(identity.value),
          Boolean(identity.verified),
          Boolean(identity.primary),
        ]
      );
      res.status(201).json({ identity: mapIdentityToZendesk(rows[0]) });
    } catch (err) {
      if (err.code === "23505") {
        throw new HttpError(409, "identity (type, value) already exists");
      }
      throw err;
    }
  })
);

export default router;
