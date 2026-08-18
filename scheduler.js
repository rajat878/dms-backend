const { pool } = require("./db/database");
const { pushCommand } = require("./firebase");

// How often to look for 'action' schedules whose fire moment has arrived.
// A schedule fires within one tick of its start_time — fine for fleet
// actions like "reboot at 2am" or "lock every day at closing time", which
// don't need sub-minute precision.
const CHECK_INTERVAL_MS = Number(process.env.SCHEDULE_CHECK_INTERVAL_MS ?? 60 * 1000);

function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || null;
}

// INSTALL_APP and PUSH_AD schedules store {apk_id} / {ad_id}, not a URL —
// that way re-uploading the same APK/ad before the schedule fires is
// picked up automatically. Resolve the real command payload right when it
// fires. Returns null if the referenced file is gone (deleted since the
// schedule was created) or PUBLIC_BASE_URL isn't set, so the caller can
// skip sending a broken command rather than crash the whole check.
async function resolveActionPayload(actionType, storedPayload) {
  if (actionType === "INSTALL_APP") {
    const apkId = storedPayload?.apk_id;
    if (!apkId) return null;
    const result = await pool.query(`SELECT id FROM apks WHERE id = $1`, [apkId]);
    if (result.rows.length === 0) {
      console.error(`schedule fire: apk ${apkId} no longer exists`);
      return null;
    }
    const base = publicBaseUrl();
    if (!base) {
      console.error("schedule fire: PUBLIC_BASE_URL is not set — can't build an install URL for a scheduled INSTALL_APP");
      return null;
    }
    return { apk_url: `${base}/api/apks/${apkId}/download` };
  }

  if (actionType === "PUSH_AD") {
    const adId = storedPayload?.ad_id;
    if (!adId) return null;
    const result = await pool.query(`SELECT name, media_type, source, external_url, duration_seconds FROM ads WHERE id = $1`, [adId]);
    if (result.rows.length === 0) {
      console.error(`schedule fire: ad ${adId} no longer exists`);
      return null;
    }
    const ad = result.rows[0];
    const common = { ad_id: adId, ad_name: ad.name, duration_seconds: ad.duration_seconds };
    if (ad.source === "upload") {
      const base = publicBaseUrl();
      if (!base) {
        console.error("schedule fire: PUBLIC_BASE_URL is not set — can't build a file URL for a scheduled PUSH_AD");
        return null;
      }
      return { media_type: ad.media_type, url: `${base}/api/ads/${adId}/file`, ...common };
    }
    return { media_type: ad.media_type, url: ad.external_url, ...common };
  }

  // Every other action type's stored payload IS the command payload
  // (SHOW_MESSAGE's {text}, SET_VOLUME/SET_BRIGHTNESS's {level},
  // SET_MUTE's {muted}, OPEN_APP's {package_name}), or there's no payload
  // at all (REBOOT, LOCK_DEVICE, RELEASE_LOCK, FORCE_LOCK, CLEAR_AD,
  // REFRESH_CONTENT).
  return storedPayload ?? null;
}

async function resolveTargetDevices(schedule) {
  if (schedule.device_id) {
    const result = await pool.query(`SELECT device_id, fcm_token FROM devices WHERE device_id = $1`, [schedule.device_id]);
    return result.rows;
  }
  const result = await pool.query(`SELECT device_id, fcm_token FROM devices WHERE group_id = $1`, [schedule.group_id]);
  return result.rows;
}

async function fireSchedule(schedule) {
  try {
    const devices = await resolveTargetDevices(schedule);
    const payload = await resolveActionPayload(schedule.action_type, schedule.action_payload);

    for (const device of devices) {
      try {
        const result = await pool.query(
          `
          INSERT INTO commands (device_id, command_type, payload)
          VALUES ($1, $2, $3)
          RETURNING id, device_id, command_type, payload, status, created_at
          `,
          [device.device_id, schedule.action_type, payload ? JSON.stringify(payload) : null]
        );
        const command = result.rows[0];
        pushCommand(device.fcm_token, command);
      } catch (err) {
        console.error(`schedule ${schedule.id}: failed to queue ${schedule.action_type} for ${device.device_id}:`, err.message);
      }
    }

    console.log(`schedule ${schedule.id} fired: ${schedule.action_type} -> ${devices.length} device(s)`);
  } finally {
    // Mark fired for today regardless of outcome (including "0 devices
    // matched") so a schedule pointed at an empty group, or one that hit
    // an error above, doesn't retry every tick for the rest of the day.
    await pool.query(
      `INSERT INTO schedule_fires (schedule_id, fire_date) VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING`,
      [schedule.id]
    );
  }
}

// Finds 'action' schedules that are due right now and haven't fired today:
// today falls within [start_date, end_date], today's weekday matches
// days_of_week (or none was set, meaning every day), start_time has
// already passed today, and there's no schedule_fires row for today yet.
async function checkOnce() {
  let due;
  try {
    due = (
      await pool.query(`
        SELECT s.*
        FROM schedules s
        WHERE s.schedule_type = 'action'
          AND CURRENT_DATE BETWEEN s.start_date AND s.end_date
          AND (s.days_of_week IS NULL OR EXTRACT(DOW FROM CURRENT_DATE)::int = ANY(s.days_of_week))
          AND s.start_time IS NOT NULL
          AND s.start_time <= CURRENT_TIME
          AND NOT EXISTS (
            SELECT 1 FROM schedule_fires f
            WHERE f.schedule_id = s.id AND f.fire_date = CURRENT_DATE
          )
      `)
    ).rows;
  } catch (err) {
    console.error("schedule check query failed:", err.message);
    return;
  }

  for (const schedule of due) {
    await fireSchedule(schedule);
  }
}

function startScheduleRunner() {
  checkOnce();
  setInterval(checkOnce, CHECK_INTERVAL_MS);
}

module.exports = { startScheduleRunner };