const { pool } = require("./db/database");

// A currently-active calendar schedule overrides the device's static
// layout_assignments row. "Active" means today falls in
// [start_date, end_date], today's weekday is in days_of_week (or it's
// unset = every day), and the current time is inside
// [start_time, end_time] (or both are unset = all day) — all evaluated in
// the DB session's timezone (see SCHEDULE_TZ in db/database.js). Note this
// doesn't support windows that cross midnight (start_time > end_time never
// matches). Device-level schedules win over group-level ones; among
// several active at once, higher `priority` wins, then the most recently
// created.
//
// Returns the resolved layout_id (or null if nothing is assigned/scheduled).
async function resolveLayoutId(deviceId, groupId) {
  const scheduleResult = await pool.query(
    `
    SELECT layout_id
    FROM schedules
    WHERE (device_id = $1 OR group_id = $2)
      AND CURRENT_DATE BETWEEN start_date AND end_date
      AND (days_of_week IS NULL OR EXTRACT(DOW FROM CURRENT_DATE)::int = ANY(days_of_week))
      AND (start_time IS NULL OR LOCALTIME BETWEEN start_time AND end_time)
    ORDER BY device_id NULLS LAST, priority DESC, created_at DESC
    LIMIT 1
    `,
    [deviceId, groupId]
  );
  if (scheduleResult.rows[0]?.layout_id) return scheduleResult.rows[0].layout_id;

  const assignmentResult = await pool.query(
    `
    SELECT la.layout_id
    FROM layout_assignments la
    WHERE la.device_id = $1 OR la.group_id = $2
    ORDER BY la.device_id NULLS LAST -- device-level assignment wins over the group's
    LIMIT 1
    `,
    [deviceId, groupId]
  );
  return assignmentResult.rows[0]?.layout_id ?? null;
}

module.exports = { resolveLayoutId };