const express = require("express");
const multer = require("multer");
const { pool } = require("../db/database");
const router = express.Router();

// APKs are stored as bytea blobs in the Postgres database that's already
// attached to this service, rather than local disk or a separate object
// store. Render's free web-service filesystem is ephemeral — anything
// written at runtime is wiped on every redeploy and whenever the free-tier
// instance spins down from inactivity, which made uploaded APKs 404 shortly
// after upload. Postgres persists independently of the web service.
//
// Tradeoffs vs a real object store (R2/B2/S3): every download is served
// through this Node process (not free CDN egress), and a free Render
// Postgres instance expires 30 days after creation and is capped at 1GB —
// fine for occasional/small-to-medium APKs, but revisit if you outgrow that.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".apk")) {
      return cb(new Error("only .apk files are accepted"));
    }
    cb(null, true);
  },
});

function downloadUrl(req, id) {
  // req.protocol reflects the real scheme (https) only because
  // server.js sets `trust proxy` — Render terminates TLS at its own
  // proxy and talks plain HTTP to this process internally otherwise,
  // which would build http:// URLs and Android refuses cleartext
  // downloads by default (API 28+).
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/api/apks/${id}/download`;
}

// POST /api/apks  (multipart form, field name "apk")
// Uploads an APK into Postgres and returns its public download URL — paste
// that into the dashboard's "Install app" box, or read it straight from
// GET /api/apks next time.
router.post("/", (req, res) => {
  upload.single("apk")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "apk file is required" });
    }

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

    try {
      const result = await pool.query(
        `INSERT INTO apks (filename, size, data) VALUES ($1, $2, $3) RETURNING id`,
        [safeName, req.file.size, req.file.buffer]
      );
      const id = result.rows[0].id;

      res.status(201).json({
        ok: true,
        id,
        filename: safeName,
        size: req.file.size,
        url: downloadUrl(req, id),
      });
    } catch (dbErr) {
      console.error("apk store error:", dbErr);
      return res.status(500).json({ ok: false, error: "failed to store apk" });
    }
  });
});

// GET /api/apks — list previously uploaded APKs so the dashboard can offer
// a picker instead of making the admin re-upload or hunt down a URL.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, size, uploaded_at FROM apks ORDER BY uploaded_at DESC`
    );
    const apks = result.rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      size: Number(row.size),
      uploaded_at: row.uploaded_at,
      url: downloadUrl(req, row.id),
    }));
    res.json({ ok: true, apks });
  } catch (err) {
    console.error("list apks error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/apks/:id/download — this is the URL that ends up in
// INSTALL_APP's apk_url. Streams the bytes back with the right content
// type so PackageInstaller on the device accepts it.
router.get("/:id/download", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT filename, content_type, data FROM apks WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "apk not found" });
    }
    const row = result.rows[0];
    res.set({
      "Content-Type": row.content_type,
      "Content-Disposition": `attachment; filename="${row.filename}"`,
      "Content-Length": row.data.length,
    });
    res.send(row.data);
  } catch (err) {
    console.error("apk download error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;