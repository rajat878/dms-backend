const express = require("express");
const router = express.Router();
const { pool } = require("../db/database");

// POST /api/devices/heartbeat
// Called by the Android agent every 15 minutes (or on-demand for testing).
// Upserts the device's latest status and logs a history row.
router.post("/heartbeat", async (req, res) => {
  const { device_id, name, battery, storage_free, app_version } = req.body;

  if (!device_id) {
    return res.status(400).json({ ok: false, error: "device_id is required" });
  }

  try {
    await pool.query(
      `
      INSERT INTO devices (device_id, name, battery, storage_free, app_version, last_seen)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (device_id) DO UPDATE SET
        name = EXCLUDED.name,
        battery = EXCLUDED.battery,
        storage_free = EXCLUDED.storage_free,
        app_version = EXCLUDED.app_version,
        last_seen = EXCLUDED.last_seen
      `,
      [device_id, name ?? null, battery ?? null, storage_free ?? null, app_version ?? null]
    );

    await pool.query(
      `INSERT INTO heartbeat_log (device_id, battery, storage_free) VALUES ($1, $2, $3)`,
      [device_id, battery ?? null, storage_free ?? null]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("heartbeat error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/devices
// Lists every known device, most recently seen first. Powers the dashboard.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM devices ORDER BY last_seen DESC`);
    res.json({ ok: true, devices: result.rows });
  } catch (err) {
    console.error("list devices error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/devices/:device_id
// Single device detail, plus its recent heartbeat history.
router.get("/:device_id", async (req, res) => {
  try {
    const deviceResult = await pool.query(
      `SELECT * FROM devices WHERE device_id = $1`,
      [req.params.device_id]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "device not found" });
    }

    const historyResult = await pool.query(
      `
      SELECT battery, storage_free, received_at
      FROM heartbeat_log
      WHERE device_id = $1
      ORDER BY received_at DESC
      LIMIT 50
      `,
      [req.params.device_id]
    );

    res.json({ ok: true, device: deviceResult.rows[0], history: historyResult.rows });
  } catch (err) {
    console.error("get device error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;
