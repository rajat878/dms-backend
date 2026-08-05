const express = require("express");
const router = express.Router();
const { pool } = require("../db/database");

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

module.exports = router;