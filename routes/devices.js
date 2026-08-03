const express = require("express");
const router = express.Router();
const { pool } = require("../db/database");
const { pushCommand } = require("../firebase");

// POST /api/devices/heartbeat
// Called by the Android agent every 15 minutes (or on-demand for testing).
// Upserts the device's latest status, logs a history row, and hands back any
// commands that are waiting for this device (marking them "delivered" so
// they aren't handed out twice).
router.post("/heartbeat", async (req, res) => {
  const {
    device_id, name, battery, power_connected,
    volume_percent, muted, brightness_percent,
    storage_free, app_version
  } = req.body;

  if (!device_id) {
    return res.status(400).json({ ok: false, error: "device_id is required" });
  }

  try {
    await pool.query(
      `
      INSERT INTO devices (
        device_id, name, battery, power_connected,
        volume_percent, muted, brightness_percent,
        storage_free, app_version, last_seen
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (device_id) DO UPDATE SET
        name = EXCLUDED.name,
        battery = EXCLUDED.battery,
        power_connected = EXCLUDED.power_connected,
        volume_percent = EXCLUDED.volume_percent,
        muted = EXCLUDED.muted,
        brightness_percent = EXCLUDED.brightness_percent,
        storage_free = EXCLUDED.storage_free,
        app_version = EXCLUDED.app_version,
        last_seen = EXCLUDED.last_seen
      `,
      [
        device_id, name ?? null, battery ?? null, power_connected ?? null,
        volume_percent ?? null, muted ?? null, brightness_percent ?? null,
        storage_free ?? null, app_version ?? null
      ]
    );

    await pool.query(
      `INSERT INTO heartbeat_log (device_id, battery, power_connected, storage_free) VALUES ($1, $2, $3, $4)`,
      [device_id, battery ?? null, power_connected ?? null, storage_free ?? null]
    );

    // Pick up anything queued for this device and mark it delivered in the
    // same round trip, so the agent can execute + ack it right away.
    const pending = await pool.query(
      `
      UPDATE commands
      SET status = 'delivered', delivered_at = NOW()
      WHERE device_id = $1 AND status = 'pending'
      RETURNING id, command_type, payload
      `,
      [device_id]
    );

    res.json({ ok: true, commands: pending.rows });
  } catch (err) {
    console.error("heartbeat error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/devices
// Lists every known device, most recently seen first, with group name
// resolved for the sidebar/grouping UI.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, g.name AS group_name
      FROM devices d
      LEFT JOIN groups g ON g.id = d.group_id
      ORDER BY d.last_seen DESC NULLS LAST
    `);
    res.json({ ok: true, devices: result.rows });
  } catch (err) {
    console.error("list devices error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/devices/bulk-commands
// Sends the same command to a set of devices in one request — used by the
// dashboard's "send to this group / all devices" bulk-send box. Each
// device still gets its own row in `commands` (independent status/history
// in its detail panel) and its own FCM push, so one offline device can't
// block delivery to the rest, and each is retried on its own next
// heartbeat if the push doesn't land.
router.post("/bulk-commands", async (req, res) => {
  const { device_ids, command_type, payload } = req.body;

  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    return res.status(400).json({ ok: false, error: "device_ids (non-empty array) is required" });
  }
  if (!command_type) {
    return res.status(400).json({ ok: false, error: "command_type is required" });
  }

  try {
    const devicesResult = await pool.query(
      `SELECT device_id, fcm_token FROM devices WHERE device_id = ANY($1::text[])`,
      [device_ids]
    );

    if (devicesResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "none of the given devices were found" });
    }

    const commands = [];
    for (const device of devicesResult.rows) {
      const result = await pool.query(
        `
        INSERT INTO commands (device_id, command_type, payload)
        VALUES ($1, $2, $3)
        RETURNING id, device_id, command_type, payload, status, created_at
        `,
        [device.device_id, command_type, payload ? JSON.stringify(payload) : null]
      );
      const command = result.rows[0];
      commands.push(command);
      pushCommand(device.fcm_token, command);
    }

    res.status(201).json({ ok: true, sent_to: commands.length, commands });
  } catch (err) {
    console.error("bulk command error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/devices/:device_id/register-token
// The Android app calls this on startup and whenever FCM issues a new
// token, so the backend can push commands to it instantly instead of
// waiting for the next heartbeat.
router.post("/:device_id/register-token", async (req, res) => {
  const { fcm_token } = req.body;

  if (!fcm_token) {
    return res.status(400).json({ ok: false, error: "fcm_token is required" });
  }

  try {
    await pool.query(
      `
      INSERT INTO devices (device_id, fcm_token)
      VALUES ($1, $2)
      ON CONFLICT (device_id) DO UPDATE SET fcm_token = EXCLUDED.fcm_token
      `,
      [req.params.device_id, fcm_token]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("register-token error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/devices/:device_id
// Single device detail, its recent heartbeat history, and its recent
// command history (for the detail panel's activity log).
router.get("/:device_id", async (req, res) => {
  try {
    const deviceResult = await pool.query(
      `
      SELECT d.*, g.name AS group_name
      FROM devices d
      LEFT JOIN groups g ON g.id = d.group_id
      WHERE d.device_id = $1
      `,
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

    const commandsResult = await pool.query(
      `
      SELECT id, command_type, payload, status, result, created_at, delivered_at, completed_at
      FROM commands
      WHERE device_id = $1
      ORDER BY created_at DESC
      LIMIT 20
      `,
      [req.params.device_id]
    );

    res.json({
      ok: true,
      device: deviceResult.rows[0],
      history: historyResult.rows,
      commands: commandsResult.rows,
    });
  } catch (err) {
    console.error("get device error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/devices/:device_id/screen
// Resolves what this device's ad player should be showing right now: its
// own direct layout assignment if it has one, otherwise its group's, in one
// query. Returns the layout template + each zone's resolved playlist
// (media_type, playable url, duration_seconds per item) — everything the
// Android player needs, so it never has to make a second request.
// Returns { ok: true, layout: null } if nothing is assigned yet.
router.get("/:device_id/screen", async (req, res) => {
  try {
    const assignmentResult = await pool.query(
      `
      SELECT la.layout_id
      FROM devices d
      LEFT JOIN layout_assignments la
        ON la.device_id = d.device_id
        OR la.group_id = d.group_id
      WHERE d.device_id = $1
      ORDER BY la.device_id NULLS LAST -- device-level assignment wins over the group's
      LIMIT 1
      `,
      [req.params.device_id]
    );

    const layoutId = assignmentResult.rows[0]?.layout_id;
    if (!layoutId) {
      return res.json({ ok: true, layout: null });
    }

    const layoutResult = await pool.query(`SELECT * FROM layouts WHERE id = $1`, [layoutId]);
    if (layoutResult.rows.length === 0) {
      return res.json({ ok: true, layout: null });
    }
    const layout = layoutResult.rows[0];

    const itemsResult = await pool.query(
      `
      SELECT lzi.zone_key, lzi.sort_order, a.id, a.name, a.media_type, a.source,
             a.external_url, a.duration_seconds
      FROM layout_zone_items lzi
      JOIN ads a ON a.id = lzi.ad_id
      WHERE lzi.layout_id = $1
      ORDER BY lzi.zone_key, lzi.sort_order
      `,
      [layoutId]
    );

    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const zones = {};
    for (const row of itemsResult.rows) {
      if (!zones[row.zone_key]) zones[row.zone_key] = [];
      zones[row.zone_key].push({
        id: row.id,
        name: row.name,
        media_type: row.media_type,
        duration_seconds: row.duration_seconds,
        url: row.source === "upload" ? `${base}/api/ads/${row.id}/file` : row.external_url,
      });
    }

    res.json({
      ok: true,
      layout: { id: layout.id, name: layout.name, template: layout.template, zones },
    });
  } catch (err) {
    console.error("get device screen error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// PATCH /api/devices/:device_id
// Currently just used to (re)assign a device to a group. group_id: null moves
// it back to "Uncategorized".
router.patch("/:device_id", async (req, res) => {
  const { group_id } = req.body;

  try {
    const result = await pool.query(
      `UPDATE devices SET group_id = $1 WHERE device_id = $2 RETURNING *`,
      [group_id ?? null, req.params.device_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "device not found" });
    }

    res.json({ ok: true, device: result.rows[0] });
  } catch (err) {
    console.error("update device error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/devices/:device_id/commands
// The dashboard calls this to queue a new command for a device. It's saved
// as "pending" immediately, then pushed to the device instantly via FCM if
// it has a registered token. If the push fails or no token is registered
// yet, the command still sits in Postgres and gets picked up on the
// device's next heartbeat regardless — so this never silently drops a command.
router.post("/:device_id/commands", async (req, res) => {
  const { command_type, payload } = req.body;

  if (!command_type) {
    return res.status(400).json({ ok: false, error: "command_type is required" });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO commands (device_id, command_type, payload)
      VALUES ($1, $2, $3)
      RETURNING id, device_id, command_type, payload, status, created_at
      `,
      [req.params.device_id, command_type, payload ? JSON.stringify(payload) : null]
    );

    const command = result.rows[0];

    // Fire-and-forget push — don't block the API response on it.
    const deviceResult = await pool.query(
      `SELECT fcm_token FROM devices WHERE device_id = $1`,
      [req.params.device_id]
    );
    pushCommand(deviceResult.rows[0]?.fcm_token, command);

    res.status(201).json({ ok: true, command });
  } catch (err) {
    console.error("create command error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/devices/:device_id/commands
// Command history for a device (used to refresh the detail panel's log).
router.get("/:device_id/commands", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, command_type, payload, status, result, created_at, delivered_at, completed_at
      FROM commands
      WHERE device_id = $1
      ORDER BY created_at DESC
      LIMIT 20
      `,
      [req.params.device_id]
    );
    res.json({ ok: true, commands: result.rows });
  } catch (err) {
    console.error("list commands error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/devices/:device_id/commands/:command_id/ack
// The agent calls this after it has executed a delivered command, reporting
// whether it succeeded.
router.post("/:device_id/commands/:command_id/ack", async (req, res) => {
  const { status, result } = req.body;

  if (!["done", "failed"].includes(status)) {
    return res.status(400).json({ ok: false, error: "status must be 'done' or 'failed'" });
  }

  try {
    const updated = await pool.query(
      `
      UPDATE commands
      SET status = $1, result = $2, completed_at = NOW()
      WHERE id = $3 AND device_id = $4
      RETURNING id
      `,
      [status, result ?? null, req.params.command_id, req.params.device_id]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "command not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("ack command error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;