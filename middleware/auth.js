// Minimal bearer-token gate for the admin-facing API.
//
// Everything under /api/* lets you reboot screens, push arbitrary content,
// install APKs, and read every device's status — that must not be reachable
// by anyone who finds the URL. This is intentionally simple (one shared
// secret, not per-user accounts) because the whole surface is "one admin
// team operating one fleet" — see README for how to move to per-user auth
// later if that changes.
//
// Two families of request are exempt on purpose, because they're called by
// the Android agent itself (or a device WebView/player), which has no
// concept of an admin session:
//   - POST /api/devices/heartbeat            (agent check-in)
//   - POST /api/devices/:id/register-token   (agent registers its FCM token)
//   - POST /api/devices/:id/plays            (agent reports proof-of-play events)
//   - GET  /api/devices/:id/screen           (player resolves what to show)
//   - GET  /api/ads/:id/file                 (player streams ad media)
//   - GET  /api/apks/:id/download            (agent downloads an APK to install)
//   - GET  /api/health                       (uptime checks)
const PUBLIC_ROUTES = [
  { method: "POST", pattern: /^\/api\/devices\/heartbeat$/ },
  { method: "POST", pattern: /^\/api\/devices\/[^/]+\/register-token$/ },
  { method: "POST", pattern: /^\/api\/devices\/[^/]+\/plays$/ },
  { method: "GET", pattern: /^\/api\/devices\/[^/]+\/screen$/ },
  { method: "GET", pattern: /^\/api\/ads\/\d+\/file$/ },
  { method: "GET", pattern: /^\/api\/apks\/\d+\/download$/ },
  { method: "GET", pattern: /^\/api\/health$/ },
];

function isPublicRoute(req) {
  return PUBLIC_ROUTES.some((r) => r.method === req.method && r.pattern.test(req.path));
}

// Constant-time-ish comparison so token checks don't leak timing info.
function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function requireAdminToken(req, res, next) {
  const configuredToken = process.env.ADMIN_TOKEN;

  // No token configured = auth is off (local/dev convenience). Logged loudly
  // on boot in server.js so this is never silently the case in production.
  if (!configuredToken) return next();

  if (isPublicRoute(req)) return next();

  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!presented || !tokensMatch(presented, configuredToken)) {
    return res.status(401).json({ ok: false, error: "unauthorized — missing or invalid admin token" });
  }

  next();
}

module.exports = { requireAdminToken };