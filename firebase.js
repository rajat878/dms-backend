const admin = require("firebase-admin");

// FIREBASE_SERVICE_ACCOUNT holds the full service account JSON (Firebase
// console -> Project settings -> Service accounts -> Generate new private
// key), pasted as one line into a Render environment variable.
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!raw) {
  console.warn(
    "FIREBASE_SERVICE_ACCOUNT is not set — commands will still be queued " +
    "but not pushed instantly. Devices will pick them up on their next heartbeat."
  );
}

let messaging = null;

if (raw) {
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  messaging = admin.messaging();
}

// Pushes a command to a device instantly via FCM. Safe to call even if
// Firebase isn't configured or the device has no token yet — it just no-ops,
// since the command is already saved in Postgres and will still be picked
// up on the device's next heartbeat regardless.
async function pushCommand(fcmToken, command) {
  if (!messaging || !fcmToken) return;

  try {
    await messaging.send({
      token: fcmToken,
      data: {
        command_id: String(command.id),
        command_type: command.command_type,
        payload: command.payload ? JSON.stringify(command.payload) : "",
      },
      android: {
        priority: "high",
      },
    });
  } catch (err) {
    console.error("FCM push failed:", err.message);
  }
}

module.exports = { pushCommand };