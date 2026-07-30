require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { initDb } = require("./db/database");
const devicesRouter = require("./routes/devices");
const groupsRouter = require("./routes/groups");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(express.static("public"));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "dms-backend", status: "running" });
});

app.use("/api/devices", devicesRouter);
app.use("/api/groups", groupsRouter);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`DMS backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});