const express = require("express");
const router = express.Router();
const crypto = require("crypto");
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
    const deviceRow = await pool.query(`SELECT device_id, group_id FROM devices WHERE device_id = $1`, [req.params.device_id]);
    if (deviceRow.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "device not found" });
    }
    const { group_id } = deviceRow.rows[0];

    // A currently-active calendar schedule overrides the static assignment
    // below. "Active" means today falls in [start_date, end_date], today's
    // weekday is in days_of_week (or it's unset = every day), and the
    // current time is inside [start_time, end_time] (or both are unset =
    // all day). Device-level schedules win over group-level ones; among
    // several active at once, higher `priority` wins, then the most
    // recently created.
    const scheduleResult = await pool.query(
      `
      SELECT layout_id
      FROM schedules
      WHERE (device_id = $1 OR group_id = $2)
        AND CURRENT_DATE BETWEEN start_date AND end_date
        AND (days_of_week IS NULL OR EXTRACT(DOW FROM CURRENT_DATE)::int = ANY(days_of_week))
        AND (start_time IS NULL OR CURRENT_TIME BETWEEN start_time AND end_time)
      ORDER BY device_id NULLS LAST, priority DESC, created_at DESC
      LIMIT 1
      `,
      [req.params.device_id, group_id]
    );

    let layoutId = scheduleResult.rows[0]?.layout_id;

    if (!layoutId) {
      const assignmentResult = await pool.query(
        `
        SELECT la.layout_id
        FROM layout_assignments la
        WHERE la.device_id = $1 OR la.group_id = $2
        ORDER BY la.device_id NULLS LAST -- device-level assignment wins over the group's
        LIMIT 1
        `,
        [req.params.device_id, group_id]
      );
      layoutId = assignmentResult.rows[0]?.layout_id;
    }

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

// DELETE /api/devices/:device_id
// Removes a device entirely (admin-only, gated by requireAdminToken like
// everything else under /api). play_logs and layout_assignments rows for
// this device are FK-cascaded automatically; commands/heartbeat_log/
// screen_share_sessions aren't FK-linked (device_id is a plain TEXT column
// there, kept that way so history survives a device being re-registered),
// so we clean those up explicitly in the same transaction. Any live screen
// share is force-closed first so the agent's socket doesn't linger.
router.delete("/:device_id", async (req, res) => {
  const deviceId = req.params.device_id;

  req.app.get("screenShare")?.closeDeviceStream(deviceId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const deleted = await client.query(
      `DELETE FROM devices WHERE device_id = $1 RETURNING device_id`,
      [deviceId]
    );

    if (deleted.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "device not found" });
    }

    await client.query(`DELETE FROM commands WHERE device_id = $1`, [deviceId]);
    await client.query(`DELETE FROM heartbeat_log WHERE device_id = $1`, [deviceId]);
    await client.query(`DELETE FROM screen_share_sessions WHERE device_id = $1`, [deviceId]);

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("delete device error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  } finally {
    client.release();
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

// POST /api/devices/:device_id/plays
// The Android agent calls this to report a batch of proof-of-play events —
// see PlayLogStore.kt for how it queues these locally and retries until
// they're confirmed. This is device-facing (no admin token — the device
// can't log in) but does require the device to already exist, same as
// every other per-device endpoint.
router.post("/:device_id/plays", async (req, res) => {
  const { plays } = req.body;

  if (!Array.isArray(plays) || plays.length === 0) {
    return res.status(400).json({ ok: false, error: "plays (non-empty array) is required" });
  }
  if (plays.length > 1000) {
    return res.status(400).json({ ok: false, error: "too many plays in one batch (max 1000)" });
  }

  try {
    const deviceResult = await pool.query(
      `SELECT device_id FROM devices WHERE device_id = $1`,
      [req.params.device_id]
    );
    if (deviceResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "device not found" });
    }

    let inserted = 0;
    for (const p of plays) {
      if (!p.ad_name || !p.media_type || !p.played_at || p.duration_seconds == null) continue;
      await pool.query(
        `
        INSERT INTO play_logs (device_id, ad_id, ad_name, media_type, layout_id, zone_key, played_at, duration_seconds)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          req.params.device_id, p.ad_id ?? null, p.ad_name, p.media_type,
          p.layout_id ?? null, p.zone_key ?? null, p.played_at, p.duration_seconds
        ]
      );
      inserted++;
    }

    res.status(201).json({ ok: true, inserted });
  } catch (err) {
    console.error("submit plays error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/devices/:device_id/screen-share/start
// Admin-only (gated by requireAdminToken like everything else under /api).
// Mints a one-time session token, stores it as a 'pending' session, and
// sends it to the agent inside a normal START_SCREEN_SHARE command over the
// existing FCM/command-queue pipeline — the agent never gets a token unless
// the backend chose to send it. The dashboard uses the returned ws_path to
// open its own admin-role WebSocket connection and subscribe.
router.post("/:device_id/screen-share/start", async (req, res) => {
  const deviceId = req.params.device_id;

  try {
    const deviceResult = await pool.query(
      `SELECT fcm_token FROM devices WHERE device_id = $1`,
      [deviceId]
    );
    if (deviceResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "device not found" });
    }

    const sessionToken = crypto.randomBytes(24).toString("hex");

    // Only one live session per device — any previous pending/active one is
    // superseded so a stale token can't be reused.
    await pool.query(
      `UPDATE screen_share_sessions SET status = 'ended', ended_at = NOW()
       WHERE device_id = $1 AND status IN ('pending', 'active')`,
      [deviceId]
    );
    await pool.query(
      `INSERT INTO screen_share_sessions (device_id, session_token, status)
       VALUES ($1, $2, 'pending')`,
      [deviceId, sessionToken]
    );

    const commandResult = await pool.query(
      `INSERT INTO commands (device_id, command_type, payload)
       VALUES ($1, 'START_SCREEN_SHARE', $2)
       RETURNING id, device_id, command_type, payload, status, created_at`,
      [deviceId, JSON.stringify({ session_token: sessionToken })]
    );
    const command = commandResult.rows[0];
    pushCommand(deviceResult.rows[0].fcm_token, command);

    res.status(201).json({
      ok: true,
      session_token: sessionToken,
      ws_path: "/ws/screen-share",
      command,
    });
  } catch (err) {
    console.error("screen-share start error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/devices/:device_id/screen-share/stop
// Ends any pending/active session for this device, force-closes the agent's
// live WebSocket if it's connected right now (no need to wait on FCM), and
// also queues a normal STOP_SCREEN_SHARE command so the agent tears down
// its foreground service/notification cleanly even if it reconnects later.
router.post("/:device_id/screen-share/stop", async (req, res) => {
  const deviceId = req.params.device_id;

  try {
    await pool.query(
      `UPDATE screen_share_sessions SET status = 'ended', ended_at = NOW()
       WHERE device_id = $1 AND status IN ('pending', 'active')`,
      [deviceId]
    );

    req.app.get("screenShare")?.closeDeviceStream(deviceId);

    const deviceResult = await pool.query(
      `SELECT fcm_token FROM devices WHERE device_id = $1`,
      [deviceId]
    );
    const commandResult = await pool.query(
      `INSERT INTO commands (device_id, command_type, payload)
       VALUES ($1, 'STOP_SCREEN_SHARE', NULL)
       RETURNING id, device_id, command_type, payload, status, created_at`,
      [deviceId]
    );
    const command = commandResult.rows[0];
    if (deviceResult.rows[0]?.fcm_token) {
      pushCommand(deviceResult.rows[0].fcm_token, command);
    }

    res.json({ ok: true, command });
  } catch (err) {
    console.error("screen-share stop error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/devices/:device_id/stop-all
// The admin's "panic button" for a single device. Two things happen:
//   1. Any of this device's commands still sitting as 'pending' (queued but
//      not yet delivered — either never reached FCM, or the device hasn't
//      had its next heartbeat yet) are marked 'cancelled' so they never
//      execute late/out of order once the device does come back.
//   2. A STOP_ALL command is queued and pushed right now — the agent
//      interprets it as "undo everything currently in effect" (clear any
//      pushed ad, dismiss any message, release any lock, end any screen
//      share). See CommandExecutor.kt's stopAll().
// Already-'delivered' commands can't be un-sent, but STOP_ALL reverses
// their visible effects anyway, so nothing is left hanging either way.
router.post("/:device_id/stop-all", async (req, res) => {
  const deviceId = req.params.device_id;

  try {
    const deviceResult = await pool.query(
      `SELECT device_id, fcm_token FROM devices WHERE device_id = $1`,
      [deviceId]
    );
    if (deviceResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "device not found" });
    }

    const cancelled = await pool.query(
      `UPDATE commands SET status = 'cancelled' WHERE device_id = $1 AND status = 'pending' RETURNING id`,
      [deviceId]
    );

    // Also end any live/pending screen share right away rather than
    // waiting on the agent to receive and act on STOP_ALL.
    await pool.query(
      `UPDATE screen_share_sessions SET status = 'ended', ended_at = NOW()
       WHERE device_id = $1 AND status IN ('pending', 'active')`,
      [deviceId]
    );
    req.app.get("screenShare")?.closeDeviceStream(deviceId);

    const commandResult = await pool.query(
      `INSERT INTO commands (device_id, command_type, payload)
       VALUES ($1, 'STOP_ALL', NULL)
       RETURNING id, device_id, command_type, payload, status, created_at`,
      [deviceId]
    );
    const command = commandResult.rows[0];
    pushCommand(deviceResult.rows[0].fcm_token, command);

    res.status(201).json({ ok: true, cancelled_pending: cancelled.rows.length, command });
  } catch (err) {
    console.error("stop-all error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/devices/stop-all
// Fleet-wide panic button — same as above but for every device (or, if
// device_ids is given, a specific subset — used by the dashboard's
// "stop all in this group" action). Loops the single-device logic per
// device so one bad/offline device can't block the rest.
router.post("/stop-all", async (req, res) => {
  const { device_ids } = req.body || {};

  try {
    const devicesResult = Array.isArray(device_ids) && device_ids.length
      ? await pool.query(`SELECT device_id, fcm_token FROM devices WHERE device_id = ANY($1::text[])`, [device_ids])
      : await pool.query(`SELECT device_id, fcm_token FROM devices`);

    if (devicesResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "no devices found" });
    }

    let totalCancelled = 0;
    const commands = [];
    for (const device of devicesResult.rows) {
      const cancelled = await pool.query(
        `UPDATE commands SET status = 'cancelled' WHERE device_id = $1 AND status = 'pending' RETURNING id`,
        [device.device_id]
      );
      totalCancelled += cancelled.rows.length;

      await pool.query(
        `UPDATE screen_share_sessions SET status = 'ended', ended_at = NOW()
         WHERE device_id = $1 AND status IN ('pending', 'active')`,
        [device.device_id]
      );
      req.app.get("screenShare")?.closeDeviceStream(device.device_id);

      const commandResult = await pool.query(
        `INSERT INTO commands (device_id, command_type, payload)
         VALUES ($1, 'STOP_ALL', NULL)
         RETURNING id, device_id, command_type, payload, status, created_at`,
        [device.device_id]
      );
      const command = commandResult.rows[0];
      commands.push(command);
      pushCommand(device.fcm_token, command);
    }

    res.status(201).json({
      ok: true,
      stopped_devices: commands.length,
      cancelled_pending: totalCancelled,
      commands,
    });
  } catch (err) {
    console.error("fleet stop-all error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/devices/:device_id/screen-share/status
// Lets the dashboard show "live" / "not sharing" without opening a socket
// first — polled when rendering the device grid.
router.get("/:device_id/screen-share/status", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, created_at FROM screen_share_sessions
       WHERE device_id = $1 AND status IN ('pending', 'active')
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.device_id]
    );
    res.json({ ok: true, session: result.rows[0] || null });
  } catch (err) {
    console.error("screen-share status error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;