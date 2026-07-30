const express = require("express");
const router = express.Router();
const { pool } = require("../db/database");

// GET /api/groups
// Lists every group along with how many devices are in it, so the sidebar
// can show counts without a second round trip per group.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.id, g.name, g.created_at, COUNT(d.device_id)::int AS device_count
      FROM groups g
      LEFT JOIN devices d ON d.group_id = g.id
      GROUP BY g.id
      ORDER BY g.name ASC
    `);
    res.json({ ok: true, groups: result.rows });
  } catch (err) {
    console.error("list groups error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/groups
// Creates a new group. { name }
router.post("/", async (req, res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ ok: false, error: "name is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO groups (name) VALUES ($1) RETURNING id, name, created_at`,
      [name.trim()]
    );
    res.status(201).json({ ok: true, group: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ ok: false, error: "a group with that name already exists" });
    }
    console.error("create group error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// DELETE /api/groups/:id
// Deletes a group. Devices in it fall back to "Uncategorized" (group_id null)
// because of the ON DELETE SET NULL foreign key.
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM groups WHERE id = $1 RETURNING id`, [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "group not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("delete group error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;