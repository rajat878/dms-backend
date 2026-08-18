const { pool } = require("./db/database");

// Thresholds are configurable via env so different fleets (phones vs.
// signage panels that report less often) can tune them without a code
// change. Defaults match what the dashboard already uses client-side.
const OFFLINE_THRESHOLD_MINUTES = Number(process.env.OFFLINE_THRESHOLD_MINUTES ?? 20);
const LOW_BATTERY_PCT = Number(process.env.LOW_BATTERY_PCT ?? 20);
const LOW_STORAGE_BYTES = Number(process.env.LOW_STORAGE_BYTES ?? 1024 * 1024 * 1024); // 1 GB
const CHECK_INTERVAL_MS = Number(process.env.ALERT_CHECK_INTERVAL_MS ?? 5 * 60 * 1000); // 5 min
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL; // Slack-compatible incoming webhook

// device_id -> Set of alert types currently firing for it, so we only
// notify on state transitions (newly-triggered / newly-resolved) instead
// of spamming the webhook every check interval.
const activeAlerts = new Map();

function computeAlerts(device) {
  const alerts = [];

  const minutesSinceSeen = device.last_seen
    ? (Date.now() - new Date(device.last_seen).getTime()) / 60000
    : Infinity;

  if (minutesSinceSeen >= OFFLINE_THRESHOLD_MINUTES) {
    alerts.push({
      type: "offline",
      message: `no heartbeat in ${Math.floor(minutesSinceSeen)} min (threshold ${OFFLINE_THRESHOLD_MINUTES})`,
    });
  }
  if (device.battery != null && device.battery >= 0 && device.battery < LOW_BATTERY_PCT) {
    alerts.push({ type: "low_battery", message: `battery at ${device.battery}%` });
  }
  if (device.storage_free != null && device.storage_free < LOW_STORAGE_BYTES) {
    const gb = (device.storage_free / 1024 ** 3).toFixed(2);
    alerts.push({ type: "low_storage", message: `only ${gb} GB free` });
  }

  return alerts;
}

// Returns the current alert list for every device — used both by the
// background webhook check and by the GET /api/devices/alerts endpoint so
// the dashboard can show a live banner without duplicating the thresholds
// in client-side JS.
async function getAllAlerts() {
  const result = await pool.query("SELECT device_id, name, last_seen, battery, storage_free FROM devices");
  const out = [];
  for (const device of result.rows) {
    const alerts = computeAlerts(device);
    if (alerts.length > 0) {
      out.push({ device_id: device.device_id, name: device.name, alerts });
    }
  }
  return out;
}

async function sendWebhook(text) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("alert webhook failed:", err.message);
  }
}

async function checkOnce() {
  let devices;
  try {
    devices = (await pool.query("SELECT device_id, name, last_seen, battery, storage_free FROM devices")).rows;
  } catch (err) {
    console.error("alert check query failed:", err.message);
    return;
  }

  for (const device of devices) {
    const currentTypes = new Set(computeAlerts(device).map((a) => a.type));
    const previousTypes = activeAlerts.get(device.device_id) ?? new Set();
    const label = device.name || device.device_id;

    for (const alert of computeAlerts(device)) {
      if (!previousTypes.has(alert.type)) {
        sendWebhook(`🔴 *${label}*: ${alert.type} — ${alert.message}`);
      }
    }
    for (const type of previousTypes) {
      if (!currentTypes.has(type)) {
        sendWebhook(`🟢 *${label}*: ${type} resolved`);
      }
    }

    activeAlerts.set(device.device_id, currentTypes);
  }
}

function startAlertMonitor() {
  if (!WEBHOOK_URL) {
    console.warn(
      "ALERT_WEBHOOK_URL is not set — alerts still computed for GET /api/devices/alerts, " +
      "but no webhook notifications will be sent."
    );
  }
  checkOnce();
  setInterval(checkOnce, CHECK_INTERVAL_MS);
}

module.exports = {
  startAlertMonitor,
  getAllAlerts,
  computeAlerts,
  OFFLINE_THRESHOLD_MINUTES,
  LOW_BATTERY_PCT,
  LOW_STORAGE_BYTES,
};