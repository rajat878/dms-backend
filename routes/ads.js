const express = require("express");
const multer = require("multer");
const { pool } = require("../db/database");
const router = express.Router();

// Ad media (images/videos) uploaded from the dashboard is stored as bytea
// in Postgres, same reasoning as apks.js: Render's free web-service disk is
// ephemeral, Postgres already isn't. 'web' ads never have bytes to store —
// they're always a live external_url (an existing landing page / HTML
// screen) rendered in a WebView on the device.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 }, // 250 MB, generous for signage video loops
});

function fileUrl(req, id) {
  // See apks.js for why trust proxy + this construction matters (avoids
  // building http:// URLs that Android refuses to load by default).
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/api/ads/${id}/file`;
}

function toPublicAd(req, row) {
  return {
    id: row.id,
    name: row.name,
    media_type: row.media_type,
    source: row.source,
    duration_seconds: row.duration_seconds,
    size: row.size != null ? Number(row.size) : null,
    created_at: row.created_at,
    // Always the URL a player should load, regardless of upload vs url.
    url: row.source === "upload" ? fileUrl(req, row.id) : row.external_url,
  };
}

// POST /api/ads
// Two ways to call this:
//   1. multipart/form-data with a "file" field (+ name, media_type,
//      duration_seconds) — for uploaded images/videos.
//   2. application/json with { name, media_type, external_url,
//      duration_seconds } — for URL-based images/videos, and for all
//      'web' ads (which have no file to upload).
router.post("/", (req, res) => {
  const isMultipart = (req.headers["content-type"] || "").startsWith("multipart/form-data");

  if (!isMultipart) {
    return createFromUrl(req, res);
  }

  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: "file is required" });

    const { name, media_type, duration_seconds } = req.body;
    if (!name || !media_type) {
      return res.status(400).json({ ok: false, error: "name and media_type are required" });
    }
    if (!["image", "video"].includes(media_type)) {
      return res.status(400).json({ ok: false, error: "uploaded files must be media_type 'image' or 'video'" });
    }

    try {
      const result = await pool.query(
        `
        INSERT INTO ads (name, media_type, source, content_type, size, data, duration_seconds)
        VALUES ($1, $2, 'upload', $3, $4, $5, $6)
        RETURNING *
        `,
        [
          name,
          media_type,
          req.file.mimetype,
          req.file.size,
          req.file.buffer,
          parseDuration(duration_seconds, media_type),
        ]
      );
      res.status(201).json({ ok: true, ad: toPublicAd(req, result.rows[0]) });
    } catch (dbErr) {
      console.error("ad upload error:", dbErr);
      res.status(500).json({ ok: false, error: "failed to store ad" });
    }
  });
});

async function createFromUrl(req, res) {
  const { name, media_type, external_url, duration_seconds } = req.body;

  if (!name || !media_type) {
    return res.status(400).json({ ok: false, error: "name and media_type are required" });
  }
  if (!["image", "video", "web"].includes(media_type)) {
    return res.status(400).json({ ok: false, error: "media_type must be image, video, or web" });
  }
  if (!external_url) {
    return res.status(400).json({ ok: false, error: "external_url is required" });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO ads (name, media_type, source, external_url, duration_seconds)
      VALUES ($1, $2, 'url', $3, $4)
      RETURNING *
      `,
      [name, media_type, external_url, parseDuration(duration_seconds, media_type)]
    );
    res.status(201).json({ ok: true, ad: toPublicAd(req, result.rows[0]) });
  } catch (dbErr) {
    console.error("ad create-from-url error:", dbErr);
    res.status(500).json({ ok: false, error: "failed to store ad" });
  }
}

// 'web' zones are typically left on screen rather than timed out (a live
// dashboard/menu board), so default them much longer than image/video.
function parseDuration(raw, mediaType) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return mediaType === "web" ? 60 : 10;
}

// GET /api/ads — list every ad for the dashboard's picker.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM ads ORDER BY created_at DESC`);
    res.json({ ok: true, ads: result.rows.map((row) => toPublicAd(req, row)) });
  } catch (err) {
    console.error("list ads error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// GET /api/ads/:id/file — streams uploaded bytes back (images/videos only;
// url-sourced ads are just fetched directly by the player from external_url).
router.get("/:id/file", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, content_type, data FROM ads WHERE id = $1 AND source = 'upload'`,
      [req.params.id]
    );
    if (result.rows.length === 0 || !result.rows[0].data) {
      return res.status(404).json({ ok: false, error: "ad file not found" });
    }
    const row = result.rows[0];
    res.set({
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Length": row.data.length,
      "Cache-Control": "public, max-age=86400",
    });
    res.send(row.data);
  } catch (err) {
    console.error("ad file error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

// DELETE /api/ads/:id — cascades out of any layout_zone_items it's used in
// (ON DELETE CASCADE), so removing an ad automatically pulls it out of
// every layout that referenced it.
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM ads WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "ad not found" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("delete ad error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;