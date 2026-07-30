const express = require("express");
const multer = require("multer");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const router = express.Router();

// APKs are stored in Cloudflare R2 (S3-compatible object storage) instead of
// local disk. Render's web-service filesystem is ephemeral — anything written
// at runtime is wiped on every redeploy and whenever the free-tier instance
// spins down from inactivity, which made uploaded APKs 404 shortly after
// upload. R2 survives all of that and has no egress fees, which matters here
// since every device downloads the same APK independently.
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // e.g. https://apks.yourdomain.com or the r2.dev URL, no trailing slash

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Multer keeps the upload in memory (no disk write) — we hand the buffer
// straight to R2.
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

function keyToUrl(key) {
  return `${R2_PUBLIC_URL}/${key}`;
}

// POST /api/apks  (multipart form, field name "apk")
// Uploads an APK to R2 and returns its public download URL — paste that into
// the dashboard's "Install app" box, or read it straight from GET /api/apks
// next time.
router.post("/", (req, res) => {
  upload.single("apk")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "apk file is required" });
    }

    // Prefix with a timestamp so re-uploading the same app name doesn't
    // clobber a version still referenced by an in-flight INSTALL_APP command.
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${Date.now()}-${safeName}`;

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: "application/vnd.android.package-archive",
        })
      );
    } catch (uploadErr) {
      console.error("R2 upload error:", uploadErr);
      return res.status(500).json({ ok: false, error: "failed to store apk" });
    }

    res.status(201).json({
      ok: true,
      filename: key,
      size: req.file.size,
      url: keyToUrl(key),
    });
  });
});

// GET /api/apks — list previously uploaded APKs so the dashboard can offer
// a picker instead of making the admin re-upload or hunt down a URL.
router.get("/", async (req, res) => {
  try {
    const result = await s3.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET })
    );

    const apks = (result.Contents || [])
      .filter((obj) => obj.Key.toLowerCase().endsWith(".apk"))
      .map((obj) => ({
        filename: obj.Key,
        size: obj.Size,
        uploaded_at: obj.LastModified,
        url: keyToUrl(obj.Key),
      }))
      .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));

    res.json({ ok: true, apks });
  } catch (err) {
    console.error("list apks error:", err);
    res.status(500).json({ ok: false, error: "internal error" });
  }
});

module.exports = router;