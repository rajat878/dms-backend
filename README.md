# DMS Backend

Minimal backend for the DMSAgent Android app. Receives heartbeats from
devices and stores their status in SQLite.

## What's included

- `GET /` — the fleet dashboard (open this in a browser)
- `POST /api/devices/heartbeat` — the Android agent calls this every 15 min
- `GET /api/devices` — list all devices (JSON, powers the dashboard)
- `GET /api/devices/:device_id` — single device detail + recent history
- `GET /api/health` — health check

## The dashboard

Open your backend's root URL in a browser (locally: `http://localhost:3000/`,
deployed: `https://your-app.onrender.com/`) to see a live table of every
device: online/offline status, battery, free storage, app version, and last
seen time. It auto-refreshes every 15 seconds — no login yet, so don't put
sensitive data behind it until Phase B (auth) is done.

A device counts as "online" if it's sent a heartbeat in the last 20 minutes
(your agent reports every 15 min, so this gives a little buffer). Adjust
`ONLINE_THRESHOLD_MINUTES` in `public/index.html` if you change the agent's
heartbeat interval.

## Step 1 — Set up a local Postgres (for local development only)

The backend now uses Postgres instead of SQLite, so data survives deploys.
For local testing you need a Postgres server running somewhere. Easiest
options:

- Install Postgres locally (postgresql.org), or
- Use a free Render Postgres instance even for local dev (see Step 3) and
  point your local `.env` at it, or
- Skip local testing entirely and just deploy straight to Render — the
  steps below cover that.

If running Postgres locally, create a database and copy `.env.example` to
`.env`, filling in your connection string:
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dms_test
```

## Step 2 — Run it locally

```bash
cd dms-backend
npm install
npm start
```

You should see:
```
DMS backend listening on port 3000
```

Test it:
```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/devices/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"device_id":"test-001","name":"Test Phone","battery":80,"storage_free":10000000000,"app_version":"1.0"}'
curl http://localhost:3000/api/devices
```

## Step 3 — Push to GitHub

```bash
cd dms-backend
git init
git add .
git commit -m "Initial DMS backend"
```
Create a new (empty) repo on GitHub, then:
```bash
git remote add origin https://github.com/YOUR_USERNAME/dms-backend.git
git branch -M main
git push -u origin main
```
(If you already have this repo pushed, just `git add .`, `git commit`, `git push` instead.)

## Step 4 — Create a Postgres database on Render

1. Go to https://render.com → **New +** → **PostgreSQL**.
2. Name it (e.g. `dms-db`), leave the free plan selected, click **Create Database**.
3. Wait for it to finish provisioning, then open it and copy the **Internal Database URL** (starts with `postgresql://`).

## Step 5 — Deploy the backend to Render

1. Click **New +** → **Web Service**.
2. Connect your `dms-backend` GitHub repo.
3. Fill in:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free is fine to start
4. Under **Environment Variables**, add:
   - Key: `DATABASE_URL`
   - Value: the Internal Database URL you copied in Step 4
5. Click **Create Web Service**. Render will build and deploy automatically.
6. Once live, you'll get a URL like:
   `https://dms-backend-xxxx.onrender.com`

Confirm it's live and the schema initialized correctly:
```bash
curl https://dms-backend-xxxx.onrender.com/api/health
```

Now redeploys (every `git push`) will **not** wipe your device data — the
database is a separate Render service from the web service.

## Step 6 — Point the Android app at it

In `ApiService.kt` in your Android project, update:
```kotlin
private const val BASE_URL = "https://dms-backend-xxxx.onrender.com/"
```
Rebuild the app, run it on a device, and check `/api/devices` again — your
real device should now show up, and stay there across future deploys.

## Notes on the free Render tier

- The free web service tier spins down after inactivity, so the first
  request after idle time may be slow (cold start) — normal, not a bug.
- The free Postgres tier expires after 30 days on Render — you'll get a
  warning email before that happens; upgrade to a paid instance or export
  your data before it's deleted if you need it long-term.

- Build a simple admin dashboard hitting `GET /api/devices`
- Add authentication (an API key per device, or a simple token) before this
  goes anywhere near real devices in the field
- Add remote command endpoints (reboot, lock, push update) once the basics
  are solid
