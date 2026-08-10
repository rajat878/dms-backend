require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { initDb } = require("./db/database");
const devicesRouter = require("./routes/devices");
const groupsRouter = require("./routes/groups");
const apksRouter = require("./routes/apks");
const adsRouter = require("./routes/ads");
const layoutsRouter = require("./routes/layouts");
const schedulesRouter = require("./routes/schedules");
const reportsRouter = require("./routes/reports");
const { startAlertMonitor, getAllAlerts } = require("./alerts");
const { requireAdminToken } = require("./middleware/auth");
const { attachScreenShareWs } = require("./ws/screenShare");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.ADMIN_TOKEN) {
  console.warn(
    "⚠️  ADMIN_TOKEN is not set — every /api route is open to anyone with the URL. " +
    "Set ADMIN_TOKEN in your environment to require it (see .env.example)."
  );
}

// Render (and most PaaS hosts) terminate TLS at their own proxy and talk
// plain HTTP to this process internally. Without this, req.protocol always
// reports "http" even for https requests — which made apks.js build
// http:// URLs for uploaded APKs, and Android refuses cleartext downloads
// by default (API 28+), so INSTALL_APP failed at the download step.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

app.use(express.static("public"));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "dms-backend", status: "running" });
});

// Everything below this line requires the admin bearer token (unless the
// specific route is on the public allow-list in middleware/auth.js).
app.use("/api", requireAdminToken);

app.use("/api/devices", devicesRouter);
app.use("/api/groups", groupsRouter);
app.use("/api/apks", apksRouter);
app.use("/api/ads", adsRouter);
app.use("/api/layouts", layoutsRouter);
app.use("/api/schedules", schedulesRouter);
app.use("/api/reports", reportsRouter);

// GET /api/devices/alerts would collide with the /:device_id route in
// devices.js (Express would treat "alerts" as a device_id), so this lives
// at its own top-level path instead.
app.get("/api/alerts", async (req, res) => {
  try {
    res.json({ ok: true, alerts: await getAllAlerts() });
  } catch (err) {
    console.error("alerts endpoint error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

const server = http.createServer(app);
const screenShare = attachScreenShareWs(server);
app.set("screenShare", screenShare);

async function start() {
  await initDb();
  startAlertMonitor();
  server.listen(PORT, () => {
    console.log(`DMS backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});