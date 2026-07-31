const { Pool } = require("pg");

// DATABASE_URL is provided automatically by Render when you attach a
// Postgres instance. For local development, set it in a .env file
// (see .env.example) pointing at your local Postgres.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and fill it in " +
    "(local dev), or attach a Postgres database in Render (production)."
  );
}

// Render's managed Postgres requires SSL, but a plain local Postgres
// usually doesn't support/need it — only enable SSL when NOT pointing
// at localhost.
const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// Creates the schema if it doesn't exist yet. Safe to call on every boot.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id            SERIAL PRIMARY KEY,
      name          TEXT UNIQUE NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id     TEXT PRIMARY KEY,
      name          TEXT,
      battery       INTEGER,
      storage_free  BIGINT,
      app_version   TEXT,
      last_seen     TIMESTAMPTZ,
      group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Column add for databases created before groups existed.
  await pool.query(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;
  `);
await pool.query(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS fcm_token TEXT;
  `);
  // Panels wired to direct/AC power (no battery) still send the same
  // battery-status broadcast — EXTRA_PLUGGED just tells you whether power
  // is currently connected, which is the meaningful signal on that
  // hardware ("unplugged" == real alert) versus a fake/absent battery %.
  await pool.query(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS power_connected BOOLEAN;
  `);
  await pool.query(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS volume_percent INTEGER;
  `);
  await pool.query(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS muted BOOLEAN;
  `);
  await pool.query(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS brightness_percent INTEGER;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS heartbeat_log (
      id            SERIAL PRIMARY KEY,
      device_id     TEXT,
      battery       INTEGER,
      power_connected BOOLEAN,
      storage_free  BIGINT,
      received_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE heartbeat_log ADD COLUMN IF NOT EXISTS power_connected BOOLEAN;
  `);

  // The command queue that makes control two-way. The dashboard inserts a
  // row with status='pending'; the agent picks it up on its next heartbeat
  // (status -> 'delivered'), executes it, then calls the ack endpoint
  // (status -> 'done' or 'failed').
  await pool.query(`
    CREATE TABLE IF NOT EXISTS commands (
      id            SERIAL PRIMARY KEY,
      device_id     TEXT NOT NULL,
      command_type  TEXT NOT NULL,
      payload       JSONB,
      status        TEXT NOT NULL DEFAULT 'pending',
      result        TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      delivered_at  TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_commands_device_status
      ON commands (device_id, status);
  `);

  // APKs stored directly in Postgres as bytea. Render's free web-service
  // filesystem is ephemeral (wiped on redeploy / spin-down from
  // inactivity), so the file bytes can't just live on disk. Postgres is
  // already attached and persists independently of the web service, so we
  // reuse it instead of standing up a separate object-storage account.
  // Fine for occasional small/medium APKs; if you outgrow the free
  // Postgres's 1GB storage or need this to survive a free-DB expiry
  // without re-uploading, move to a real object store (R2, B2, etc).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS apks (
      id            SERIAL PRIMARY KEY,
      filename      TEXT NOT NULL,
      content_type  TEXT NOT NULL DEFAULT 'application/vnd.android.package-archive',
      size          BIGINT NOT NULL,
      data          BYTEA NOT NULL,
      uploaded_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

module.exports = { pool, initDb };