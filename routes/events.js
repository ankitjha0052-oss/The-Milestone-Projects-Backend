const express = require("express");
const router = express.Router();
const EventEmitter = require("events");
const pool = require("./pool");
const { verifyAccessToken } = require("./authHelper");

// Global Event Emitter for internal decoupled notifications
const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

// Active SSE Connections
// userId -> Set<Response>
const userConnections = new Map();
// Set<Response> for Superadmin connections
const adminConnections = new Set();

/**
 * Dispatch event to specific user's connected tabs
 */
function emitToUser(userId, data) {
  if (!userId) return;
  const conns = userConnections.get(String(userId));
  if (conns && conns.size > 0) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of conns) {
      try {
        res.write(payload);
      } catch (err) {
        conns.delete(res);
      }
    }
  }
}

/**
 * Dispatch event to all Superadmin connected tabs
 */
function emitToAdmin(data) {
  if (adminConnections.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of adminConnections) {
    try {
      res.write(payload);
    } catch (err) {
      adminConnections.delete(res);
    }
  }
}

/**
 * Broadcast event to every connected client
 */
function emitBroadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const set of userConnections.values()) {
    for (const res of set) {
      try {
        res.write(payload);
      } catch (_) {}
    }
  }
  for (const res of adminConnections) {
    try {
      res.write(payload);
    } catch (_) {}
  }
}

// Wire internal event bus listeners
eventBus.on("user_event", ({ userId, data }) => emitToUser(userId, data));
eventBus.on("admin_event", (data) => emitToAdmin(data));
eventBus.on("broadcast_event", (data) => emitBroadcast(data));

/**
 * SSE Stream Endpoint: GET /events/stream?token=<accessToken>
 * Supported by native browser EventSource
 */
router.get("/stream", async (req, res) => {
  // 1. Extract Bearer token from query param (native EventSource) or auth header
  let token = req.query.token;
  if (!token && req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
    token = req.headers.authorization.substring(7).trim();
  }

  if (!token) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Token required for live events stream" } });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return res.status(401).json({ error: { code: err.code || "INVALID_TOKEN", message: "Invalid or expired token" } });
  }

  const userId = payload.userId;
  let isAdmin = false;
  let isCandidateOrEmployer = false;

  // 2. Identify user from DB & verify is_active status
  try {
    const [users] = await pool.query("SELECT id, role, user_type, is_active FROM users WHERE id = ?", [userId]);
    if (users.length > 0) {
      if (!users[0].is_active) {
        return res.status(403).json({ error: { code: "ACCOUNT_DISABLED", message: "Account deactivated" } });
      }
      isCandidateOrEmployer = true;
      if (users[0].role === "admin" || users[0].role === "superadmin") {
        isAdmin = true;
      }
    } else {
      // Check superadmin table
      const [admins] = await pool.query("SELECT id, role, is_active FROM superadmin WHERE id = ?", [userId]);
      if (admins.length > 0) {
        if (!admins[0].is_active) {
          return res.status(403).json({ error: { code: "ACCOUNT_DISABLED", message: "Admin account deactivated" } });
        }
        isAdmin = true;
      } else {
        return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
      }
    }
  } catch (dbErr) {
    return res.status(500).json({ error: { code: "DB_ERROR", message: "Failed to verify user session" } });
  }

  // 3. Set SSE HTTP headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Disables reverse-proxy buffering (Nginx, Render, Railway, AWS)
  });
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  // Initial connection ack
  res.write(`data: ${JSON.stringify({ type: "CONNECTED", userId, isAdmin })}\n\n`);

  // 4. Register connection into active map
  const sUserId = String(userId);
  if (!userConnections.has(sUserId)) {
    userConnections.set(sUserId, new Set());
  }
  userConnections.get(sUserId).add(res);

  if (isAdmin) {
    adminConnections.add(res);
  }

  // 5. Keep-Alive Heartbeat every 25 seconds (prevents proxy timeouts)
  const heartbeatTimer = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch (_) {
      clearInterval(heartbeatTimer);
    }
  }, 25000);

  // 6. Cleanup on client disconnect / tab close
  req.on("close", () => {
    clearInterval(heartbeatTimer);
    const set = userConnections.get(sUserId);
    if (set) {
      set.delete(res);
      if (set.size === 0) {
        userConnections.delete(sUserId);
      }
    }
    if (isAdmin) {
      adminConnections.delete(res);
    }
    res.end();
  });
});

module.exports = {
  eventsRouter: router,
  emitToUser,
  emitToAdmin,
  emitBroadcast,
  eventBus,
};
