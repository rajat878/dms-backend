const express = require("express");
const router = express.Router();
const { pool } = require("../db/database");

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Every device action the calendar is allowed to schedule, and how to
// validate the payload the admin fills in for it. Mirrors the command
// types CommandExecutor.kt actually understands (minus the two
// screen-share commands, which are a live session concept, not something
// that makes sense to fire from a date/time).
const ACTION_TYPES = {
  REFRESH_CONTENT: { payload: false },
  CLEAR_AD: { payload: false },
  LOCK_DEVICE: { payload: false },
  RELEASE_LOCK: { payload: false },
  FORCE_LOCK: { payload: false },
  REBOOT: { payload: false },
  SHOW_MESSAGE: {
    payload: true,
    validate(p) {
      if (!p || typeof p.text !== "string" || !p.text.trim()) return "action_payload.text is required";
      return null;
    },
  },
  SET_VOLUME: {
    payload: true,
    validate(p) {
      if (!p || !Number.isInteger(p.level) || p.level < 0 || p.level > 100) return "action_payload.level must be an integer 0-100";
      return null;
    },
  },
  SET_BRIGHTNESS: {
    payload: true,
    validate(p) {
      if (!p || !Number.isInteger(p.level) || p.level < 0 || p.level > 100) return "action_payload.level must be an integer 0-100";
      return null;
    },
  },
  SET_MUTE: {
    payload: true,
    validate(p) {
      if (!p || typeof p.muted !== "boolean") return "action_payload.muted must be true or false";
      return null;
    },
  },
  OPEN_APP: {
    payload: true,
    validate(p) {
      if (!p || typeof p.package_name !== "string" || !p.package_name.trim()) return "action_payload.package_name is required";
      return null;
    },
  },
  INSTALL_APP: {
    payload: true,
    validate(p) {
      if (!p || !Number.isInteger(p.apk_id)) return "action_payload.apk_id is required";
      return null;
    },
  },
  PUSH_AD: {
    payload: true,
    validate(p) {
      if (!p || !Number.isInteger(p.ad_id)) return "action_payload.ad_id is required";
      return null;
    },
  },
};

function validateBody(body, { partial = false } = {}) {
  const {
    schedule_type, layout_id, device_id, group_id, title,
    start_date, end_date, start_time, end_time, days_of_week, priority,
    action_type, action_payload,
  } = body;

  const type = schedule_type || "content";
  if (!partial || schedule_type !== undefined) {
    if (!["content", "action"].includes(type)) return "schedule_type must be 'content' or 'action'";
  }

  if (type === "content") {
    if (!partial || layout_id !== undefined) {
      if (!layout_id) return "layout_id is required for a content schedule";
    }
  } else {
    if (!partial || action_type !== undefined) {
      if (!action_type || !ACTION_TYPES[action_type]) {
        return `action_type must be one of: ${Object.keys(ACTION_TYPES).join(", ")}`;
      }
    }
    if (action_type && ACTION_TYPES[action_type]?.payload && (!partial || action_payload !== undefined)) {
      const payloadErr = ACTION_TYPES[action_type].validate(action_payload);
      if (payloadErr) return payloadErr;
    }
    if (!partial || start_time !== undefined) {
      if (!start_time) return "start_time is required for a device-action schedule — it's the moment the action fires";
    }
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
  // Content schedules are a continuous "active while" window, so
  // start_time/end_time must be both-set (a daily window) or both-blank
  // (all day). Action schedules are a single fire moment — only
  // start_time is meaningful — so this pairing only applies to content.
  if (type === "content" && ((start_time && !end_time) || (!start_time && end_time))) {
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

// Shared SELECT for list/get — LEFT JOINs everything since a row is either
// a content schedule (layout_id set) or an action schedule (action_type
// set, optionally pointing at an apk/ad by id inside action_payload).
// action_apk_name / action_ad_name let the calendar show "Install
// MyApp.apk" / "Push Diwali Promo" instead of a raw id.
const SELECT_SCHEDULE = `
  SELECT s.*, l.name AS layout_name, d.name AS device_name, g.name AS group_name,
    ak.filename AS action_apk_name, ad.name AS action_ad_name
  FROM schedules s
  LEFT JOIN layouts l ON l.id = s.layout_id
  LEFT JOIN devices d ON d.device_id = s.device_id
  LEFT JOIN groups g ON g.id = s.group_id
  LEFT JOIN apks ak ON s.action_type = 'INSTALL_APP' AND ak.id = (s.action_payload->>'apk_id')::int
  LEFT JOIN ads ad ON s.action_type = 'PUSH_AD' AND ad.id = (s.action_payload->>'ad_id')::int
`;

// GET /api/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD
// Lists schedules (both content and action), optionally restricted to ones
// that overlap a date range (used by the calendar view — the dashboard
// passes the visible month). Without from/to, returns everything (used by
// list/edit UIs).
router.get("/", async (req, res) => {
  const { from, to } = req.query;
  try {
    const clauses = [];
    const params = [];
    if (from) { params.push(from); clauses.push(`s.end_date >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`s.start_date <= $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const result = await pool.query(
      `${SELECT_SCHEDULE} ${where} ORDER BY s.start_date, s.start_time NULLS FIRST, s.created_at`,
      params
    );
    res.json({ ok: true, schedules: result.rows, day_names: DOW_NAMES, action_types: Object.keys(ACTION_TYPES) });
  } catch (err) {
    console.error("list schedules error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/schedules/:id
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(`${SELECT_SCHEDULE} WHERE s.id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "schedule not found" });
    res.json({ ok: true, schedule: result.rows[0] });
  } catch (err) {
    console.error("get schedule error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// POST /api/schedules
// Content:  { schedule_type:'content', layout_id, device_id|group_id, title?,
//             start_date, end_date, start_time?, end_time?, days_of_week?, priority? }
// Action:   { schedule_type:'action', action_type, action_payload?, device_id|group_id, title?,
//             start_date, end_date, start_time, days_of_week? }
//   (action's start_time is the single moment it fires each matching day;
//   end_time is derived automatically, not sent by the client)
router.post("/", async (req, res) => {
  const err = validateBody(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });

  const schedule_type = req.body.schedule_type || "content";
  const { device_id, group_id, title, start_date, end_date, days_of_week, priority } = req.body;
  const layout_id = schedule_type === "content" ? req.body.layout_id : null;
  const action_type = schedule_type === "action" ? req.body.action_type : null;
  const action_payload = schedule_type === "action" && ACTION_TYPES[action_type]?.payload ? req.body.action_payload : null;
  // Action schedules are a single fire moment, not a window — store
  // end_time equal to start_time so the row still satisfies the table's
  // original "both set or both null" pairing without it meaning anything.
  const start_time = schedule_type === "action" ? req.body.start_time : (req.body.start_time ?? null);
  const end_time = schedule_type === "action" ? req.body.start_time : (req.body.end_time ?? null);

  try {
    if (schedule_type === "content") {
      const layoutCheck = await pool.query(`SELECT id FROM layouts WHERE id = $1`, [layout_id]);
      if (layoutCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "layout not found" });
    } else if (action_type === "INSTALL_APP") {
      const apkCheck = await pool.query(`SELECT id FROM apks WHERE id = $1`, [action_payload.apk_id]);
      if (apkCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "apk not found" });
    } else if (action_type === "PUSH_AD") {
      const adCheck = await pool.query(`SELECT id FROM ads WHERE id = $1`, [action_payload.ad_id]);
      if (adCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "ad not found" });
    }

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
        schedule_type, layout_id, device_id, group_id, title,
        start_date, end_date, start_time, end_time, days_of_week, priority,
        action_type, action_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
      `,
      [
        schedule_type, layout_id, device_id ?? null, group_id ?? null, title ?? null,
        start_date, end_date, start_time ?? null, end_time ?? null,
        days_of_week && days_of_week.length ? days_of_week : null, priority ?? 0,
        action_type, action_payload ? JSON.stringify(action_payload) : null,
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

  const schedule_type = req.body.schedule_type || "content";
  const { device_id, group_id, title, start_date, end_date, days_of_week, priority } = req.body;
  const layout_id = schedule_type === "content" ? req.body.layout_id : null;
  const action_type = schedule_type === "action" ? req.body.action_type : null;
  const action_payload = schedule_type === "action" && ACTION_TYPES[action_type]?.payload ? req.body.action_payload : null;
  const start_time = schedule_type === "action" ? req.body.start_time : (req.body.start_time ?? null);
  const end_time = schedule_type === "action" ? req.body.start_time : (req.body.end_time ?? null);

  try {
    if (schedule_type === "content") {
      const layoutCheck = await pool.query(`SELECT id FROM layouts WHERE id = $1`, [layout_id]);
      if (layoutCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "layout not found" });
    } else if (action_type === "INSTALL_APP") {
      const apkCheck = await pool.query(`SELECT id FROM apks WHERE id = $1`, [action_payload.apk_id]);
      if (apkCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "apk not found" });
    } else if (action_type === "PUSH_AD") {
      const adCheck = await pool.query(`SELECT id FROM ads WHERE id = $1`, [action_payload.ad_id]);
      if (adCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "ad not found" });
    }

    const result = await pool.query(
      `
      UPDATE schedules SET
        schedule_type = $1, layout_id = $2, device_id = $3, group_id = $4, title = $5,
        start_date = $6, end_date = $7, start_time = $8, end_time = $9,
        days_of_week = $10, priority = $11, action_type = $12, action_payload = $13
      WHERE id = $14
      RETURNING *
      `,
      [
        schedule_type, layout_id, device_id ?? null, group_id ?? null, title ?? null,
        start_date, end_date, start_time ?? null, end_time ?? null,
        days_of_week && days_of_week.length ? days_of_week : null, priority ?? 0,
        action_type, action_payload ? JSON.stringify(action_payload) : null,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "schedule not found" });

    // Editing a schedule (e.g. pushing its fire time later) should let it
    // fire again today if it hasn't yet — clear today's fire record so an
    // action schedule the admin just rescheduled doesn't silently skip today.
    await pool.query(`DELETE FROM schedule_fires WHERE schedule_id = $1 AND fire_date = CURRENT_DATE`, [req.params.id]);

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
