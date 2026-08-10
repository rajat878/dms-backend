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

  // One row per live-screen-view attempt. session_token is the one-time
  // secret the agent must present on the WebSocket connection — it's handed
  // to the agent inside the START_SCREEN_SHARE command payload (delivered
  // over the existing FCM channel), so knowing a device_id alone is never
  // enough to pull its screen. status moves pending -> active (agent
  // connected + streaming) -> ended (admin stopped it, agent disconnected,
  // or it expired).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS screen_share_sessions (
      id            SERIAL PRIMARY KEY,
      device_id     TEXT NOT NULL,
      session_token TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      ended_at      TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_screen_share_device_status
      ON screen_share_sessions (device_id, status);
  `);

  // APKs stored directly in Postgres as bytea. Render's free web-service
  // filesystem is ephemeral (wiped on redeploy / spin-down from
  // inactivity), so the file bytes can't just live on disk. Postgres is
  // already attached and persists independently of the web service, so we
  // reuse it instead of standing up a separate object-storage account.
  // Fine for occasional small/medium APKs; if you outgrow the free
  // Postgres's 1GB storage or need this to survive a free-DB expiry
  // without re-uploading, move to a real object store (R2, B2, etc).
  // ---- Digital signage / ads --------------------------------------------
  // A single piece of playable content. Same "store small uploads in
  // Postgres, keep it optional for external URLs" split as apks above:
  // media_type is 'image' | 'video' | 'web'. source is 'upload' (bytes live
  // in `data`) or 'url' (bytes live elsewhere, `external_url` points at
  // them — this is also how 'web' content always works, since a live page
  // can't be stored as a blob).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      media_type        TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'web', 'text')),
      source            TEXT NOT NULL CHECK (source IN ('upload', 'url')),
      content_type      TEXT,
      size              BIGINT,
      data              BYTEA,
      external_url      TEXT,
      duration_seconds  INTEGER NOT NULL DEFAULT 10,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Migration: earlier deployments created `ads` before 'text' existed as a
  // media_type, so their CHECK constraint only allows ('image','video','web').
  // CREATE TABLE IF NOT EXISTS above is a no-op on those, so fix it here by
  // dropping and re-adding the constraint with 'text' included. Safe to run
  // every boot: DROP...IF EXISTS + re-add is idempotent.
  await pool.query(`
    ALTER TABLE ads DROP CONSTRAINT IF EXISTS ads_media_type_check;
  `);
  await pool.query(`
    ALTER TABLE ads ADD CONSTRAINT ads_media_type_check
      CHECK (media_type IN ('image', 'video', 'web', 'text'));
  `);

  // A layout is just a named template ('split2' | 'split3' | 'grid4' |
  // 'pip' | 'ticker') — the fixed zone keys for each template live in the
  // Android app (LayoutTemplates.kt) and in the dashboard, not in the DB,
  // so adding a new template later doesn't need a migration.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS layouts (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      template      TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Each zone of a layout plays its own ordered list of ads (its own
  // "playlist"), independent of the other zones — that's what lets 2-3 ads
  // rotate on screen at once in different areas.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS layout_zone_items (
      id            SERIAL PRIMARY KEY,
      layout_id     INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
      zone_key      TEXT NOT NULL,
      ad_id         INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
      sort_order    INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_layout_zone_items_layout
      ON layout_zone_items (layout_id, zone_key, sort_order);
  `);

  // A layout is assigned to exactly one of: a single device, or a whole
  // group (every device in that group shows it). Device-level assignment
  // takes priority when both exist for a device — see the resolution query
  // in routes/devices.js (:device_id/screen).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS layout_assignments (
      id            SERIAL PRIMARY KEY,
      layout_id     INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
      device_id     TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
      group_id      INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      CHECK (
        (device_id IS NOT NULL AND group_id IS NULL) OR
        (device_id IS NULL AND group_id IS NOT NULL)
      )
    );
  `);
  // Only one active assignment per device / per group — re-assigning
  // replaces it (see the ON CONFLICT upsert in routes/layouts.js) instead
  // of piling up history rows.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_layout_assignments_device
      ON layout_assignments (device_id) WHERE device_id IS NOT NULL;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_layout_assignments_group
      ON layout_assignments (group_id) WHERE group_id IS NOT NULL;
  `);

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

  // ---- Proof-of-play ------------------------------------------------
  // One row per zone item actually shown on a screen. The Android player
  // logs these locally the instant an item's on-screen window starts (see
  // PlayLogStore.kt) and batches them up to POST /api/devices/:id/plays
  // whenever it has a connection — so a play that happened while the
  // device was offline still shows up here once it reconnects, just late.
  //
  // ad_name/media_type are snapshotted at play time (not just joined via
  // ad_id) so a report from last month still reads correctly even if that
  // ad was since renamed or deleted — that's the whole point of a proof-
  // of-play record: it has to remain accurate as a historical fact.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS play_logs (
      id                SERIAL PRIMARY KEY,
      device_id         TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      ad_id             INTEGER REFERENCES ads(id) ON DELETE SET NULL,
      ad_name           TEXT NOT NULL,
      media_type        TEXT NOT NULL,
      layout_id         INTEGER REFERENCES layouts(id) ON DELETE SET NULL,
      zone_key          TEXT,
      played_at         TIMESTAMPTZ NOT NULL,
      duration_seconds  INTEGER NOT NULL,
      received_at       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_play_logs_played_at ON play_logs (played_at);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_play_logs_device_played ON play_logs (device_id, played_at);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_play_logs_ad_played ON play_logs (ad_id, played_at);
  `);

  // ---- Content calendar / scheduling --------------------------------
  // A schedule says "show this layout on this device/group, on these
  // dates, optionally only on certain days of the week and/or only within
  // a daily time window". When one is currently active it overrides the
  // device's static layout_assignments row (see the resolution query in
  // routes/devices.js :device_id/screen) — the static assignment remains
  // as the fallback for whenever no schedule is active.
  //
  // days_of_week uses Postgres's EXTRACT(DOW) numbering: 0=Sunday..6=Saturday.
  // NULL/empty means "every day in the date range". start_time/end_time are
  // both NULL for an all-day schedule, or both set for a daily window
  // (e.g. 09:00–18:00) — note this doesn't support windows that cross
  // midnight (start_time > end_time is treated as never matching).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id            SERIAL PRIMARY KEY,
      layout_id     INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
      device_id     TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
      group_id      INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      title         TEXT,
      start_date    DATE NOT NULL,
      end_date      DATE NOT NULL,
      start_time    TIME,
      end_time      TIME,
      days_of_week  SMALLINT[],
      priority      INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      CHECK (
        (device_id IS NOT NULL AND group_id IS NULL) OR
        (device_id IS NULL AND group_id IS NOT NULL)
      ),
      CHECK (end_date >= start_date),
      CHECK ((start_time IS NULL) = (end_time IS NULL))
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_schedules_device ON schedules (device_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_schedules_group ON schedules (group_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_schedules_dates ON schedules (start_date, end_date);
  `);
}

module.exports = { pool, initDb };