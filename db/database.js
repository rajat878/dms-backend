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
    CREATE TABLE IF NOT EXISTS devices (
      device_id     TEXT PRIMARY KEY,
      name          TEXT,
      battery       INTEGER,
      storage_free  BIGINT,
      app_version   TEXT,
      last_seen     TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS heartbeat_log (
      id            SERIAL PRIMARY KEY,
      device_id     TEXT,
      battery       INTEGER,
      storage_free  BIGINT,
      received_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

module.exports = { pool, initDb };
