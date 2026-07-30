const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const router = express.Router();

// APKs live under public/apks — express.static("public") in server.js
// already serves that directory, so an uploaded file is downloadable by
// the Android agent immediately at /apks/<filename>, no extra route needed.
const APK_DIR = path.join(__dirname, "public", "apks");
fs.mkdirSync(APK_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, APK_DIR),
  filename: (req, file, cb) => {
    // Prefix with a timestamp so re-uploading the same app name doesn't
    // clobber a version still referenced by an in-flight INSTALL_APP command.
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".apk")) {
      return cb(new Error("only .apk files are accepted"));
    }
    cb(null, true);
  },
});

// POST /api/apks  (multipart form, field name "apk")
// Uploads an APK and returns its absolute download URL — paste that into
// the dashboard's "Install app" box, or read it straight from GET /api/apks
// next time.
router.post("/", (req, res) => {
  upload.single("apk")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "apk file is required" });
    }

    const url = `${req.protocol}://${req.get("host")}/apks/${req.file.filename}`;
    res.status(201).json({
      ok: true,
      filename: req.file.filename,
      size: req.file.size,
      url,
    });
  });
});

// GET /api/apks — list previously uploaded APKs so the dashboard can offer
// a picker instead of making the admin re-upload or hunt down a URL.
router.get("/", (req, res) => {
  fs.readdir(APK_DIR, (err, files) => {
    if (err) {
      return res.status(500).json({ ok: false, error: "internal error" });
    }
    const apks = files
      .filter((f) => f.toLowerCase().endsWith(".apk"))
      .map((f) => {
        const stat = fs.statSync(path.join(APK_DIR, f));
        return {
          filename: f,
          size: stat.size,
          uploaded_at: stat.mtime,
          url: `${req.protocol}://${req.get("host")}/apks/${f}`,
        };
      })
      .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    res.json({ ok: true, apks });
  });
});

module.exports = router;