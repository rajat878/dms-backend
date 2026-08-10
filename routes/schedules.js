const express = require("express");
const router = express.Router();
const { pool } = require("../db/database");

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function validateBody(body, { partial = false } = {}) {
  const {
    layout_id, device_id, group_id, title,
    start_date, end_date, start_time, end_time, days_of_week, priority,
  } = body;

  if (!partial || layout_id !== undefined) {
    if (!layout_id) return "layout_id is required";
  }
  if (!partial || device_id !== undefined || group_id !== undefined) {
    if (!device_id && !group_id) return "device_id or group_id is required";
    if (device_id && group_id) return "assign to a device OR a group, not both";
  }
  if (!partial || start_date !== undefined) {
    if (!start_date) return "start_date is required";
  }
  if (!partial || end_date !== undefined) {
    if (!end_date) return "end_date is required";
  }
  if (start_date && end_date && String(end_date) < String(start_date)) {
    return "end_date must be on or after start_date";
  }
  if ((start_time && !end_time) || (!start_time && end_time)) {
    return "start_time and end_time must be set together (or both left blank for all-day)";
  }
  if (days_of_week !== undefined && days_of_week !== null) {
    if (!Array.isArray(days_of_week) || days_of_week.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return "days_of_week must be an array of integers 0-6 (0=Sunday)";
    }
  }
  if (priority !== undefined && priority !== null && !Number.isInteger(priority)) {
    return "priority must be an integer";
  }
  return null;
}

// GET /api/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD
// Lists schedules, optionally restricted to ones that overlap a date range
// (used by the calendar view — the dashboard passes the visible month).
// Without from/to, returns everything (used by list/edit UIs).
router.get("/", async (req, res) => {
  const { from, to } = req.query;
  try {
    const clauses = [];
    const params = [];
    if (from) { params.push(from); clauses.push(`s.end_date >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`s.start_date <= $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT s.*, l.name AS layout_name, d.name AS device_name, g.name AS group_name
      FROM schedules s
      JOIN layouts l ON l.id = s.layout_id
      LEFT JOIN devices d ON d.device_id = s.device_id
      LEFT JOIN groups g ON g.id = s.group_id
      ${where}
      ORDER BY s.start_date, s.start_time NULLS FIRST, s.created_at
      `,
      params
    );
    res.json({ ok: true, schedules: result.rows, day_names: DOW_NAMES });
  } catch (err) {
    console.error("list schedules error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/schedules/:id
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT s.*, l.name AS layout_name, d.name AS device_name, g.name AS group_name
      FROM schedules s
      JOIN layouts l ON l.id = s.layout_id
      LEFT JOIN devices d ON d.device_id = s.device_id
      LEFT JOIN groups g ON g.id = s.group_id
      WHERE s.id = $1
      `,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "schedule not found" });
    res.json({ ok: true, schedule: result.rows[0] });
  } catch (err) {
    console.error("get schedule error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/schedules
// body: { layout_id, device_id|group_id, title?, start_date, end_date,
//          start_time?, end_time?, days_of_week?, priority? }
router.post("/", async (req, res) => {
  const err = validateBody(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });

  const {
    layout_id, device_id, group_id, title,
    start_date, end_date, start_time, end_time, days_of_week, priority,
  } = req.body;

  try {
    const layoutCheck = await pool.query(`SELECT id FROM layouts WHERE id = $1`, [layout_id]);
    if (layoutCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "layout not found" });

    if (device_id) {
      const deviceCheck = await pool.query(`SELECT device_id FROM devices WHERE device_id = $1`, [device_id]);
      if (deviceCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "device not found" });
    } else {
      const groupCheck = await pool.query(`SELECT id FROM groups WHERE id = $1`, [group_id]);
      if (groupCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "group not found" });
    }

    const result = await pool.query(
      `
      INSERT INTO schedules (
        layout_id, device_id, group_id, title,
        start_date, end_date, start_time, end_time, days_of_week, priority
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        layout_id, device_id ?? null, group_id ?? null, title ?? null,
        start_date, end_date, start_time ?? null, end_time ?? null,
        days_of_week && days_of_week.length ? days_of_week : null, priority ?? 0,
      ]
    );
    res.status(201).json({ ok: true, schedule: result.rows[0] });
  } catch (err2) {
    console.error("create schedule error:", err2);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// PUT /api/schedules/:id — full update (dashboard's edit form re-sends every field).
router.put("/:id", async (req, res) => {
  const err = validateBody(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });

  const {
    layout_id, device_id, group_id, title,
    start_date, end_date, start_time, end_time, days_of_week, priority,
  } = req.body;

  try {
    const layoutCheck = await pool.query(`SELECT id FROM layouts WHERE id = $1`, [layout_id]);
    if (layoutCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "layout not found" });

    const result = await pool.query(
      `
      UPDATE schedules SET
        layout_id = $1, device_id = $2, group_id = $3, title = $4,
        start_date = $5, end_date = $6, start_time = $7, end_time = $8,
        days_of_week = $9, priority = $10
      WHERE id = $11
      RETURNING *
      `,
      [
        layout_id, device_id ?? null, group_id ?? null, title ?? null,
        start_date, end_date, start_time ?? null, end_time ?? null,
        days_of_week && days_of_week.length ? days_of_week : null, priority ?? 0,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "schedule not found" });
    res.json({ ok: true, schedule: result.rows[0] });
  } catch (err2) {
    console.error("update schedule error:", err2);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// DELETE /api/schedules/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM schedules WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "schedule not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("delete schedule error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;