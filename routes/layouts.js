const express = require("express");
const { pool } = require("../db/database");
const { pushCommand } = require("../firebase");
const router = express.Router();

// The valid zone keys per template. Kept in sync with LayoutTemplates.kt on
// the Android side and the layout builder in public/index.html. Enforced
// here too so a bad zone_key can't get saved and silently render nothing.
const TEMPLATE_ZONES = {
  split2: ["left", "right"],
  split3: ["main", "top_right", "bottom_right"],
  grid4: ["top_left", "top_right", "bottom_left", "bottom_right"],
  pip: ["main", "pip"],
  ticker: ["main", "ticker"],
};

async function fetchLayoutDetail(layoutId) {
  const layoutResult = await pool.query(`SELECT * FROM layouts WHERE id = $1`, [layoutId]);
  if (layoutResult.rows.length === 0) return null;
  const layout = layoutResult.rows[0];

  const itemsResult = await pool.query(
    `
    SELECT lzi.zone_key, lzi.sort_order, a.*
    FROM layout_zone_items lzi
    JOIN ads a ON a.id = lzi.ad_id
    WHERE lzi.layout_id = $1
    ORDER BY lzi.zone_key, lzi.sort_order
    `,
    [layoutId]
  );

  const zones = {};
  for (const zoneKey of TEMPLATE_ZONES[layout.template] || []) zones[zoneKey] = [];
  for (const row of itemsResult.rows) {
    if (!zones[row.zone_key]) zones[row.zone_key] = [];
    zones[row.zone_key].push({
      id: row.id,
      name: row.name,
      media_type: row.media_type,
      duration_seconds: row.duration_seconds,
    });
  }

  return { id: layout.id, name: layout.name, template: layout.template, created_at: layout.created_at, zones };
}

// POST /api/layouts
// body: { name, template, zones: { zone_key: [ad_id, ad_id, ...] } }
// Each zone's array is the play order for that zone's independent playlist.
router.post("/", async (req, res) => {
  const { name, template, zones } = req.body;

  if (!name || !template) {
    return res.status(400).json({ ok: false, error: "name and template are required" });
  }
  const validZones = TEMPLATE_ZONES[template];
  if (!validZones) {
    return res.status(400).json({
      ok: false,
      error: `unknown template '${template}' — must be one of: ${Object.keys(TEMPLATE_ZONES).join(", ")}`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const layoutResult = await client.query(
      `INSERT INTO layouts (name, template) VALUES ($1, $2) RETURNING id`,
      [name, template]
    );
    const layoutId = layoutResult.rows[0].id;

    await insertZoneItems(client, layoutId, validZones, zones);

    await client.query("COMMIT");
    res.status(201).json({ ok: true, layout: await fetchLayoutDetail(layoutId) });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("create layout error:", err);
    res.status(500).json({ ok: false, error: "failed to create layout" });
  } finally {
    client.release();
  }
});

async function insertZoneItems(client, layoutId, validZones, zones) {
  if (!zones) return;
  for (const zoneKey of Object.keys(zones)) {
    if (!validZones.includes(zoneKey)) {
      throw new Error(`zone '${zoneKey}' is not valid for this template (expected one of: ${validZones.join(", ")})`);
    }
    const adIds = zones[zoneKey];
    if (!Array.isArray(adIds)) continue;
    for (let i = 0; i < adIds.length; i++) {
      await client.query(
        `INSERT INTO layout_zone_items (layout_id, zone_key, ad_id, sort_order) VALUES ($1, $2, $3, $4)`,
        [layoutId, zoneKey, adIds[i], i]
      );
    }
  }
}

// GET /api/layouts — list, with a quick zone-count summary for the dashboard table.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.*, COUNT(lzi.id) AS item_count
      FROM layouts l
      LEFT JOIN layout_zone_items lzi ON lzi.layout_id = l.id
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `);
    res.json({
      ok: true,
      layouts: result.rows.map((r) => ({ ...r, item_count: Number(r.item_count) })),
      templates: TEMPLATE_ZONES,
    });
  } catch (err) {
    console.error("list layouts error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/layouts/:id — full detail with resolved zone playlists.
router.get("/:id", async (req, res) => {
  try {
    const layout = await fetchLayoutDetail(req.params.id);
    if (!layout) return res.status(404).json({ ok: false, error: "layout not found" });
    res.json({ ok: true, layout });
  } catch (err) {
    console.error("get layout error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// PUT /api/layouts/:id — replace name + all zone playlists in one go
// (simplest mental model for a dashboard editor: load, edit, save-whole-thing).
router.put("/:id", async (req, res) => {
  const { name, zones } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const layoutResult = await client.query(`SELECT * FROM layouts WHERE id = $1`, [req.params.id]);
    if (layoutResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "layout not found" });
    }
    const layout = layoutResult.rows[0];
    const validZones = TEMPLATE_ZONES[layout.template];

    if (name) {
      await client.query(`UPDATE layouts SET name = $1 WHERE id = $2`, [name, req.params.id]);
    }

    await client.query(`DELETE FROM layout_zone_items WHERE layout_id = $1`, [req.params.id]);
    await insertZoneItems(client, req.params.id, validZones, zones);

    await client.query("COMMIT");
    const updated = await fetchLayoutDetail(req.params.id);
    await notifyAssignedDevices(updated.id);
    res.json({ ok: true, layout: updated });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("update layout error:", err);
    res.status(500).json({ ok: false, error: err.message || "failed to update layout" });
  } finally {
    client.release();
  }
});

// DELETE /api/layouts/:id
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM layouts WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "layout not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("delete layout error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/layouts/:id/assign
// body: { device_id } XOR { group_id } — assigns this layout to a single
// screen or to every device in a group, replacing any prior assignment for
// that device/group, then pushes REFRESH_CONTENT immediately so the
// change shows up on screen without waiting for the next heartbeat.
router.post("/:id/assign", async (req, res) => {
  const { device_id, group_id } = req.body;
  if (!device_id && !group_id) {
    return res.status(400).json({ ok: false, error: "device_id or group_id is required" });
  }
  if (device_id && group_id) {
    return res.status(400).json({ ok: false, error: "assign to a device OR a group, not both" });
  }

  try {
    const layoutCheck = await pool.query(`SELECT id FROM layouts WHERE id = $1`, [req.params.id]);
    if (layoutCheck.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "layout not found" });
    }

    if (device_id) {
      await pool.query(
        `
        INSERT INTO layout_assignments (layout_id, device_id)
        VALUES ($1, $2)
        ON CONFLICT (device_id) WHERE device_id IS NOT NULL DO UPDATE SET layout_id = EXCLUDED.layout_id, created_at = NOW()
        `,
        [req.params.id, device_id]
      );
    } else {
      await pool.query(
        `
        INSERT INTO layout_assignments (layout_id, group_id)
        VALUES ($1, $2)
        ON CONFLICT (group_id) WHERE group_id IS NOT NULL DO UPDATE SET layout_id = EXCLUDED.layout_id, created_at = NOW()
        `,
        [req.params.id, group_id]
      );
    }

    const notified = await notifyAssignedDevices(req.params.id, { device_id, group_id });
    res.json({ ok: true, notified });
  } catch (err) {
    console.error("assign layout error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// Queues + instantly pushes a REFRESH_CONTENT command
// are affected, so a newly assigned/edited layout shows up right away
// instead of waiting up to 15 minutes for the next heartbeat poll.
async function notifyAssignedDevices(layoutId, target) {
  let deviceRows;
  if (target?.device_id) {
    deviceRows = await pool.query(
      `SELECT device_id, fcm_token FROM devices WHERE device_id = $1`,
      [target.device_id]
    );
  } else if (target?.group_id) {
    deviceRows = await pool.query(
      `SELECT device_id, fcm_token FROM devices WHERE group_id = $1`,
      [target.group_id]
    );
  } else {
    // Layout content itself changed (PUT) — refresh everyone it's assigned to,
    // directly or via a group.
    deviceRows = await pool.query(
      `
      SELECT DISTINCT d.device_id, d.fcm_token
      FROM devices d
      LEFT JOIN layout_assignments la_device ON la_device.device_id = d.device_id
      LEFT JOIN layout_assignments la_group ON la_group.group_id = d.group_id
      WHERE la_device.layout_id = $1 OR la_group.layout_id = $1
      `,
      [layoutId]
    );
  }

  for (const device of deviceRows.rows) {
    const commandResult = await pool.query(
      `INSERT INTO commands (device_id, command_type, payload) VALUES ($1, 'REFRESH_CONTENT', NULL)
       RETURNING id, device_id, command_type, payload`,
      [device.device_id]
    );
    pushCommand(device.fcm_token, commandResult.rows[0]);
  }
  return deviceRows.rows.length;
}

module.exports = router;
module.exports.TEMPLATE_ZONES = TEMPLATE_ZONES;