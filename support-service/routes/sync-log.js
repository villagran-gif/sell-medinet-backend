import { Router } from "express";
import { getPool } from "../db.js";
import { asyncHandler, HttpError } from "../lib/errors.js";

const router = Router();

function isoDate(value) {
  if (!value) return null;
  if (typeof value?.toISOString === "function") return value.toISOString();
  return value;
}

function mapEntry(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    entity: row.entity,
    entity_id: row.entity_id,
    op: row.op,
    source: row.source,
    diff: row.diff ?? {},
    created_at: isoDate(row.created_at),
  };
}

function parseDate(raw) {
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(400, `invalid date: ${raw}`);
  }
  return d;
}

// POST /api/v2/sync-log   body: { entry: {entity, entity_id?, op, source?, diff?} }
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const entry = req.body?.entry;
    if (!entry || typeof entry !== "object") {
      throw new HttpError(400, "missing entry object in body");
    }
    if (!entry.entity || !entry.op) {
      throw new HttpError(400, "entry.entity and entry.op are required");
    }

    const { rows } = await getPool().query(
      `INSERT INTO support.sync_log (entity, entity_id, op, source, diff)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [
        String(entry.entity),
        entry.entity_id != null ? String(entry.entity_id) : null,
        String(entry.op),
        entry.source != null ? String(entry.source) : null,
        JSON.stringify(entry.diff ?? {}),
      ]
    );
    res.status(201).json({ entry: mapEntry(rows[0]) });
  })
);

// GET /api/v2/sync-log?entity=&entity_id=&op=&source=&since=&until=&limit=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions = [];
    const values = [];
    let i = 1;

    const addEq = (col, raw) => {
      conditions.push(`${col} = $${i++}`);
      values.push(String(raw));
    };

    if (req.query.entity) addEq("entity", req.query.entity);
    if (req.query.entity_id) addEq("entity_id", req.query.entity_id);
    if (req.query.op) addEq("op", req.query.op);
    if (req.query.source) addEq("source", req.query.source);
    if (req.query.since) {
      conditions.push(`created_at >= $${i++}`);
      values.push(parseDate(req.query.since));
    }
    if (req.query.until) {
      conditions.push(`created_at <= $${i++}`);
      values.push(parseDate(req.query.until));
    }

    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 1000));

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM support.sync_log ${where}
                 ORDER BY id DESC LIMIT ${limit}`;
    const { rows } = await getPool().query(sql, values);

    res.json({
      entries: rows.map(mapEntry),
      count: rows.length,
      next_page: null,
      previous_page: null,
    });
  })
);

// GET /api/v2/sync-log/stats?days=7
// Agregado por entity + op en la ventana de N días (max 90).
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const raw = Number(req.query.days ?? 7);
    const days = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 7, 90));

    const { rows } = await getPool().query(
      `SELECT entity, op, COUNT(*)::int AS count
       FROM support.sync_log
       WHERE created_at >= now() - (INTERVAL '1 day' * $1)
       GROUP BY entity, op
       ORDER BY count DESC`,
      [days]
    );

    res.json({
      window_days: days,
      stats: rows.map((r) => ({ entity: r.entity, op: r.op, count: r.count })),
      total: rows.reduce((s, r) => s + r.count, 0),
    });
  })
);

export default router;
