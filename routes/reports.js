const express = require("express");
const router = express.Router();
const { pool } = require("../db/database");
const { computeAlerts, OFFLINE_THRESHOLD_MINUTES, LOW_BATTERY_PCT } = require("../alerts");

/**
 * Proof-of-play reporting. This is what turns raw play_logs rows (written
 * by POST /api/devices/:id/plays, one per zone item actually shown) into
 * something a human — or an advertiser being billed per play — can read:
 * a per-ad summary, a browsable recent-activity list, and a CSV export.
 *
 * All three endpoints share the same optional filters:
 *   from, to     ISO date/datetime bounds on played_at (default: last 30 days)
 *   device_id    restrict to one device
 *   group_id     restrict to every device currently in one group
 *   ad_id        restrict to one piece of content
 */
function buildFilters(query) {
  const clauses = [];
  const params = [];

  const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = query.to ? new Date(query.to) : new Date();
  params.push(from.toISOString());
  clauses.push(`pl.played_at >= $${params.length}`);
  params.push(to.toISOString());
  clauses.push(`pl.played_at <= $${params.length}`);

  if (query.device_id) {
    params.push(query.device_id);
    clauses.push(`pl.device_id = $${params.length}`);
  }
  if (query.ad_id) {
    params.push(Number(query.ad_id));
    clauses.push(`pl.ad_id = $${params.length}`);
  }
  if (query.group_id) {
    params.push(Number(query.group_id));
    clauses.push(`d.group_id = $${params.length}`);
  }

  return { where: clauses.join(" AND "), params };
}

// GET /api/reports/plays/summary
// One row per ad: how many times it played, total on-air seconds, how many
// distinct devices/screens it showed on, and its first/last play in range.
// This is the "did my campaign run, and how much" answer.
router.get("/plays/summary", async (req, res) => {
  try {
    const { where, params } = buildFilters(req.query);
    const result = await pool.query(
      `
      SELECT
        pl.ad_id,
        pl.ad_name,
        pl.media_type,
        COUNT(*)::int AS play_count,
        COALESCE(SUM(pl.duration_seconds), 0)::int AS total_seconds,
        COUNT(DISTINCT pl.device_id)::int AS device_count,
        MIN(pl.played_at) AS first_played_at,
        MAX(pl.played_at) AS last_played_at
      FROM play_logs pl
      JOIN devices d ON d.device_id = pl.device_id
      WHERE ${where}
      GROUP BY pl.ad_id, pl.ad_name, pl.media_type
      ORDER BY play_count DESC
      `,
      params
    );

    const totals = result.rows.reduce(
      (acc, r) => ({
        play_count: acc.play_count + r.play_count,
        total_seconds: acc.total_seconds + r.total_seconds,
      }),
      { play_count: 0, total_seconds: 0 }
    );

    res.json({ ok: true, ads: result.rows, totals });
  } catch (err) {
    console.error("plays summary error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/reports/plays
// Raw, paginated play events for the "recent activity" list — newest first.
router.get("/plays", async (req, res) => {
  try {
    const { where, params } = buildFilters(req.query);
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    params.push(limit);
    params.push(offset);

    const result = await pool.query(
      `
      SELECT pl.id, pl.device_id, d.name AS device_name, pl.ad_id, pl.ad_name,
             pl.media_type, pl.layout_id, pl.zone_key, pl.played_at, pl.duration_seconds
      FROM play_logs pl
      JOIN devices d ON d.device_id = pl.device_id
      WHERE ${where}
      ORDER BY pl.played_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    res.json({ ok: true, plays: result.rows });
  } catch (err) {
    console.error("list plays error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/reports/plays/export
// Full CSV of every matching play event — the file you'd actually hand to
// an advertiser as proof their content ran. Capped at 50k rows per export
// (~30 days of a busy multi-screen fleet); narrow the date range for more.
router.get("/plays/export", async (req, res) => {
  try {
    const { where, params } = buildFilters(req.query);
    const result = await pool.query(
      `
      SELECT pl.played_at, d.name AS device_name, pl.device_id, g.name AS group_name,
             pl.ad_name, pl.media_type, pl.zone_key, pl.duration_seconds
      FROM play_logs pl
      JOIN devices d ON d.device_id = pl.device_id
      LEFT JOIN groups g ON g.id = d.group_id
      WHERE ${where}
      ORDER BY pl.played_at ASC
      LIMIT 50000
      `,
      params
    );

    const escapeCsv = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["played_at", "device_name", "device_id", "group_name", "ad_name", "media_type", "zone_key", "duration_seconds"];
    const lines = [header.join(",")];
    for (const row of result.rows) {
      lines.push(header.map((col) => escapeCsv(row[col])).join(","));
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="proof-of-play-${Date.now()}.csv"`);
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("export plays error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/reports/plays/timeseries
// Plays bucketed by time — the line-chart feed for the dashboard. Same
// filters as the other endpoints, plus:
//   granularity   'hour' | 'day' | 'week'  (default: 'day')
// date_trunc does the bucketing in the DB session's timezone (SCHEDULE_TZ,
// see db/database.js) so "Aug 18" lines up with what an admin in that
// timezone would call "today" — matches how schedules.js already reasons
// about wall-clock time.
const VALID_GRANULARITIES = new Set(["hour", "day", "week"]);

router.get("/plays/timeseries", async (req, res) => {
  try {
    const granularity = VALID_GRANULARITIES.has(req.query.granularity) ? req.query.granularity : "day";
    const { where, params } = buildFilters(req.query);

    const result = await pool.query(
      `
      SELECT
        date_trunc('${granularity}', pl.played_at) AS bucket,
        COUNT(*)::int AS play_count,
        COALESCE(SUM(pl.duration_seconds), 0)::int AS total_seconds,
        COUNT(DISTINCT pl.device_id)::int AS device_count
      FROM play_logs pl
      JOIN devices d ON d.device_id = pl.device_id
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket
      `,
      params
    );

    res.json({ ok: true, granularity, buckets: result.rows });
  } catch (err) {
    console.error("plays timeseries error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/reports/fleet/snapshot
// The numbers behind the dashboard's KPI cards. Unlike the plays/* endpoints
// above, this reads from `devices` (current state) rather than `play_logs`
// (historical events) — "how healthy is the fleet right now", not "what
// played in a date range". Reuses alerts.js's computeAlerts() so the
// thresholds shown here can never drift out of sync with what actually
// triggers a webhook alert.
router.get("/fleet/snapshot", async (req, res) => {
  try {
    const devicesResult = await pool.query(
      "SELECT device_id, name, last_seen, battery, storage_free, group_id FROM devices"
    );

    let online = 0;
    let offline = 0;
    let lowBattery = 0;
    let lowStorage = 0;
    const alertsByDevice = [];

    for (const device of devicesResult.rows) {
      const alerts = computeAlerts(device);
      const isOffline = alerts.some((a) => a.type === "offline");
      isOffline ? offline++ : online++;
      if (alerts.some((a) => a.type === "low_battery")) lowBattery++;
      if (alerts.some((a) => a.type === "low_storage")) lowStorage++;
      if (alerts.length > 0) {
        alertsByDevice.push({ device_id: device.device_id, name: device.name, alerts });
      }
    }

    // Plays "today" — in the DB session's timezone, same reasoning as the
    // timeseries bucketing above, so this KPI card agrees with the chart.
    const todayResult = await pool.query(
      `SELECT COUNT(*)::int AS play_count
       FROM play_logs
       WHERE played_at >= date_trunc('day', now())`
    );

    res.json({
      ok: true,
      devices: {
        total: devicesResult.rows.length,
        online,
        offline,
        low_battery: lowBattery,
        low_storage: lowStorage,
      },
      plays_today: todayResult.rows[0].play_count,
      active_alerts: alertsByDevice,
      thresholds: {
        offline_minutes: OFFLINE_THRESHOLD_MINUTES,
        low_battery_pct: LOW_BATTERY_PCT,
      },
    });
  } catch (err) {
    console.error("fleet snapshot error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

/**
 * Action/command reporting. Every command the admin ever issues (reboot,
 * lock, push ad, install app, screen share, etc.) is already recorded in
 * `commands` the instant it's created (status='pending', created_at=NOW())
 * and updated IN PLACE on the same row as it moves through its lifecycle:
 *   pending -> delivered (FCM push reached the device / picked up on
 *              next heartbeat) -> done | failed (device executed it and
 *              acked, see POST /:device_id/commands/:id/ack) or cancelled
 *              (admin/bulk-stop cancelled it before delivery)
 * So "recorded immediately, updated when it stops" is already true of the
 * underlying data — these endpoints just expose it the same way
 * plays/* exposes play_logs, instead of it being buried in each device's
 * detail-panel history (capped at 20 rows, no filtering, no export).
 *
 * Shares the same optional filters as the plays/* endpoints:
 *   from, to        ISO date/datetime bounds on created_at (default: last 30 days)
 *   device_id       restrict to one device
 *   group_id        restrict to every device currently in one group
 *   command_type    restrict to one action type (e.g. 'REBOOT', 'PUSH_AD')
 *   status          restrict to one status (pending|delivered|done|failed|cancelled)
 */
function buildActionFilters(query) {
  const clauses = [];
  const params = [];

  const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = query.to ? new Date(query.to) : new Date();
  params.push(from.toISOString());
  clauses.push(`c.created_at >= $${params.length}`);
  params.push(to.toISOString());
  clauses.push(`c.created_at <= $${params.length}`);

  if (query.device_id) {
    params.push(query.device_id);
    clauses.push(`c.device_id = $${params.length}`);
  }
  if (query.group_id) {
    params.push(Number(query.group_id));
    clauses.push(`d.group_id = $${params.length}`);
  }
  if (query.command_type) {
    params.push(query.command_type);
    clauses.push(`c.command_type = $${params.length}`);
  }
  if (query.status) {
    params.push(query.status);
    clauses.push(`c.status = $${params.length}`);
  }

  return { where: clauses.join(" AND "), params };
}

// GET /api/reports/actions
// Raw, paginated action/command events for the "recent activity" list —
// newest first. Each row is live: a row for a still-pending or
// still-delivered command will show status flip to done/failed on refresh,
// same row, no new row created — matches how the dashboard's device drawer
// already behaves, just fleet-wide and filterable/exportable here.
router.get("/actions", async (req, res) => {
  try {
    const { where, params } = buildActionFilters(req.query);
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    params.push(limit);
    params.push(offset);

    const result = await pool.query(
      `
      SELECT c.id, c.device_id, d.name AS device_name, g.name AS group_name,
             c.command_type, c.payload, c.status, c.result,
             c.created_at, c.delivered_at, c.completed_at
      FROM commands c
      JOIN devices d ON d.device_id = c.device_id
      LEFT JOIN groups g ON g.id = d.group_id
      WHERE ${where}
      ORDER BY c.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    res.json({ ok: true, actions: result.rows });
  } catch (err) {
    console.error("list actions error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/reports/actions/summary
// One row per command_type: how many times it was issued, and a breakdown
// of where each one currently sits in its lifecycle. The "did my fleet
// actually receive/run this" answer, mirroring plays/summary's "did my
// campaign run" role for ads.
router.get("/actions/summary", async (req, res) => {
  try {
    const { where, params } = buildActionFilters(req.query);
    const result = await pool.query(
      `
      SELECT
        c.command_type,
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE c.status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE c.status = 'delivered')::int AS delivered_count,
        COUNT(*) FILTER (WHERE c.status = 'done')::int AS done_count,
        COUNT(*) FILTER (WHERE c.status = 'failed')::int AS failed_count,
        COUNT(*) FILTER (WHERE c.status = 'cancelled')::int AS cancelled_count,
        COUNT(DISTINCT c.device_id)::int AS device_count,
        MIN(c.created_at) AS first_issued_at,
        MAX(c.created_at) AS last_issued_at
      FROM commands c
      JOIN devices d ON d.device_id = c.device_id
      WHERE ${where}
      GROUP BY c.command_type
      ORDER BY total_count DESC
      `,
      params
    );

    const totals = result.rows.reduce((acc, r) => ({ total_count: acc.total_count + r.total_count }), { total_count: 0 });

    res.json({ ok: true, action_types: result.rows, totals });
  } catch (err) {
    console.error("actions summary error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/reports/actions/export
// Full CSV of every matching action — an audit trail you can hand to
// someone showing exactly what was done, on what device, by when, and
// its outcome. Same 50k row cap/reasoning as plays/export.
router.get("/actions/export", async (req, res) => {
  try {
    const { where, params } = buildActionFilters(req.query);
    const result = await pool.query(
      `
      SELECT c.created_at, c.delivered_at, c.completed_at, d.name AS device_name,
             c.device_id, g.name AS group_name, c.command_type, c.payload,
             c.status, c.result
      FROM commands c
      JOIN devices d ON d.device_id = c.device_id
      LEFT JOIN groups g ON g.id = d.group_id
      WHERE ${where}
      ORDER BY c.created_at ASC
      LIMIT 50000
      `,
      params
    );

    const escapeCsv = (v) => {
      if (v == null) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["created_at", "delivered_at", "completed_at", "device_name", "device_id", "group_name", "command_type", "payload", "status", "result"];
    const lines = [header.join(",")];
    for (const row of result.rows) {
      lines.push(header.map((col) => escapeCsv(row[col])).join(","));
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="action-log-${Date.now()}.csv"`);
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("export actions error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;