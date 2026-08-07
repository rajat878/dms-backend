// Live screen viewing — plain WebSockets, no socket.io, so both the
// Android agent (OkHttp WebSocket) and the browser dashboard (native
// WebSocket) can speak the exact same tiny protocol.
//
// Two kinds of connection share one path, distinguished by ?role=:
//
//   Agent:  wss://host/ws/screen-share?role=device&device_id=X&token=Y
//           - `token` must match a pending/active row in
//             screen_share_sessions for that device_id (issued by
//             POST /api/devices/:id/screen-share/start, delivered to the
//             agent inside the START_SCREEN_SHARE command payload).
//           - Sends BINARY frames, each one full JPEG image. Nothing else.
//           - Also sends JSON text messages of its own:
//               {"type":"control_status","available":true|false}
//                 (whether RemoteControlService/Accessibility is turned on
//                 for this device right now)
//
//   Admin:  wss://host/ws/screen-share?role=admin&token=ADMIN_TOKEN
//           - `token` must match process.env.ADMIN_TOKEN (same shared
//             secret the REST API uses), when one is configured.
//           - Sends JSON text control messages:
//               {"type":"subscribe","device_id":"X"}
//               {"type":"unsubscribe","device_id":"X"}
//               {"type":"input","device_id":"X","event":{...}}
//                 (tap/swipe/text/key — see validateInputEvent below; only
//                 relayed to a device this admin socket is subscribed to)
//           - Receives JSON text messages:
//               {"type":"frame","device_id":"X","data":"<base64 jpeg>","ts":167...}
//               {"type":"device_offline","device_id":"X"}
//               {"type":"control_status","device_id":"X","available":true|false}
//
// Frames are relayed device -> admins only; an agent never receives its
// own stream back, and admins can't send frames. Input events flow the
// other direction, admin -> device only, and only for a device the
// sending admin socket currently has an active subscription to — there is
// no separate control channel and no way to send input to a device you
// aren't actively viewing.

const { WebSocketServer } = require("ws");
const { pool } = require("../db/database");

// Guards against a misbehaving/compromised agent flooding memory or a slow
// admin connection — a screen frame at sane resolution/quality should be a
// few tens of KB, comfortably under this.
const MAX_FRAME_BYTES = 400 * 1024;
const HEARTBEAT_INTERVAL_MS = 30000;

// A bad/compromised admin session shouldn't be able to send anything but
// a well-formed input event — this is the only place arbitrary admin
// input reaches a device, so shape and bounds are checked strictly rather
// than trusted and passed through.
const MAX_TEXT_LENGTH = 4000;

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function isNormalized(n) {
  return isFiniteNumber(n) && n >= 0 && n <= 1;
}

function validateInputEvent(event) {
  if (!event || typeof event !== "object") return null;
  switch (event.action) {
    case "tap":
      if (!isNormalized(event.x) || !isNormalized(event.y)) return null;
      return { action: "tap", x: event.x, y: event.y };
    case "swipe": {
      if (![event.x1, event.y1, event.x2, event.y2].every(isNormalized)) return null;
      const duration = isFiniteNumber(event.duration_ms)
        ? Math.min(Math.max(event.duration_ms, 50), 3000)
        : 200;
      return {
        action: "swipe",
        x1: event.x1, y1: event.y1,
        x2: event.x2, y2: event.y2,
        duration_ms: duration,
      };
    }
    case "text": {
      if (typeof event.value !== "string" || event.value.length === 0) return null;
      if (event.value.length > MAX_TEXT_LENGTH) return null;
      return { action: "text", value: event.value };
    }
    case "key":
      if (!["back", "home", "recents"].includes(event.key)) return null;
      return { action: "key", key: event.key };
    default:
      return null;
  }
}

function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function attachScreenShareWs(server) {
  const wss = new WebSocketServer({ noServer: true });

  // device_id -> ws (only one live agent connection per device at a time)
  const deviceSockets = new Map();
  // device_id -> Set<ws> (admin viewers currently subscribed)
  const subscribers = new Map();

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws/screen-share") return; // let other upgrade handlers (if any) see it

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, url);
    });
  });

  wss.on("connection", async (ws, url) => {
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token") || "";

    if (role === "device") {
      const deviceId = url.searchParams.get("device_id");
      if (!deviceId) return ws.close(4000, "device_id required");

      try {
        const result = await pool.query(
          `SELECT id FROM screen_share_sessions
           WHERE device_id = $1 AND session_token = $2 AND status IN ('pending', 'active')
           ORDER BY created_at DESC LIMIT 1`,
          [deviceId, token]
        );
        if (result.rows.length === 0) {
          return ws.close(4001, "invalid or expired session token");
        }
        await pool.query(
          `UPDATE screen_share_sessions SET status = 'active' WHERE id = $1`,
          [result.rows[0].id]
        );
      } catch (err) {
        console.error("screen-share device auth error:", err);
        return ws.close(1011, "internal error");
      }

      setupDeviceSocket(ws, deviceId);
    } else if (role === "admin") {
      const configuredToken = process.env.ADMIN_TOKEN;
      if (configuredToken && !tokensMatch(token, configuredToken)) {
        return ws.close(4003, "unauthorized");
      }
      setupAdminSocket(ws);
    } else {
      ws.close(4000, "role must be 'device' or 'admin'");
    }
  });

  function setupDeviceSocket(ws, deviceId) {
    // A device reconnecting (app restart, network blip) replaces its old
    // socket rather than stacking up — only the newest stream matters.
    const existing = deviceSockets.get(deviceId);
    if (existing && existing !== ws) existing.close(4009, "replaced by newer connection");
    deviceSockets.set(deviceId, ws);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (data, isBinary) => {
      const admins = subscribers.get(deviceId);

      if (isBinary) {
        if (data.length > MAX_FRAME_BYTES) return;
        if (!admins || admins.size === 0) return;

        const payload = JSON.stringify({
          type: "frame",
          device_id: deviceId,
          data: data.toString("base64"),
          ts: Date.now(),
        });
        for (const admin of admins) {
          if (admin.readyState === admin.OPEN) admin.send(payload);
        }
        return;
      }

      // Text frames from the agent are its own status messages
      // (currently just control_status) — validate shape, stamp the
      // device_id (the agent doesn't send one, it doesn't need to know
      // it), and relay to whoever's watching.
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== "control_status" || typeof msg.available !== "boolean") return;
      if (!admins || admins.size === 0) return;
      const payload = JSON.stringify({
        type: "control_status",
        device_id: deviceId,
        available: msg.available,
      });
      for (const admin of admins) {
        if (admin.readyState === admin.OPEN) admin.send(payload);
      }
    });

    const cleanup = () => {
      if (deviceSockets.get(deviceId) === ws) deviceSockets.delete(deviceId);
      pool
        .query(
          `UPDATE screen_share_sessions SET status = 'ended', ended_at = NOW()
           WHERE device_id = $1 AND status IN ('pending', 'active')`,
          [deviceId]
        )
        .catch((err) => console.error("screen-share session cleanup error:", err));

      const admins = subscribers.get(deviceId);
      if (admins) {
        const payload = JSON.stringify({ type: "device_offline", device_id: deviceId });
        for (const admin of admins) {
          if (admin.readyState === admin.OPEN) admin.send(payload);
        }
      }
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  function setupAdminSocket(ws) {
    ws.subscribedDevices = new Set();
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "subscribe" && msg.device_id) {
        ws.subscribedDevices.add(msg.device_id);
        if (!subscribers.has(msg.device_id)) subscribers.set(msg.device_id, new Set());
        subscribers.get(msg.device_id).add(ws);
      } else if (msg.type === "unsubscribe" && msg.device_id) {
        ws.subscribedDevices.delete(msg.device_id);
        subscribers.get(msg.device_id)?.delete(ws);
      } else if (msg.type === "input" && msg.device_id) {
        // The core authorization check: this admin socket must currently
        // be subscribed (i.e. actively viewing) that exact device. Being
        // authenticated as *an* admin is not enough on its own.
        if (!ws.subscribedDevices.has(msg.device_id)) return;

        const event = validateInputEvent(msg.event);
        if (!event) return;

        const deviceWs = deviceSockets.get(msg.device_id);
        if (!deviceWs || deviceWs.readyState !== deviceWs.OPEN) return;

        deviceWs.send(JSON.stringify({ type: "input", event }));
      }
    });

    const cleanup = () => {
      for (const deviceId of ws.subscribedDevices) {
        subscribers.get(deviceId)?.delete(ws);
      }
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  // Standard ws dead-connection reaping (mobile networks drop connections
  // without a clean close far more often than a wired admin browser does).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  // Lets the REST "stop" endpoint force-close a live agent stream
  // immediately instead of waiting for the STOP_SCREEN_SHARE command to
  // round-trip through FCM.
  function closeDeviceStream(deviceId) {
    deviceSockets.get(deviceId)?.close(4000, "stopped by admin");
  }

  return { closeDeviceStream };
}

module.exports = { attachScreenShareWs };