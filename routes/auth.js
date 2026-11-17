const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  getRefreshCookieOptions,
  verifyGoogleIdToken,
  verifyAppleIdToken,
  generateAppleClientSecret,
  findOrCreateUserWithIdentity,
  createSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
} = require("./authHelper");
const authMiddleware = require("./authMiddleware");

const router = express.Router();

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many attempts, try later." } },
});

router.use(authRateLimiter);

// 1. POST /auth/google
router.post("/google", async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "idToken is required" } });

    const googleUser = await verifyGoogleIdToken(idToken);
    const user = await findOrCreateUserWithIdentity({
      provider: "google",
      providerUserId: googleUser.sub,
      email: googleUser.email,
      emailVerified: googleUser.emailVerified,
      name: googleUser.name,
      picture: googleUser.picture,
      locale: googleUser.locale,
    });

    const { accessToken, refreshToken } = await createSession(
      user.id,
      req.headers["user-agent"],
      req.ip
    );

    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());
    res.json({ accessToken, user });
  } catch (err) {
    next(err);
  }
});

// 2. POST /auth/apple
router.post("/apple", async (req, res, next) => {
  try {
    const { idToken, user: appleMeta } = req.body;
    if (!idToken) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "idToken is required" } });

    const appleUser = await verifyAppleIdToken(idToken);

    let fullName = undefined;
    if (appleMeta && appleMeta.name) {
      fullName = [appleMeta.name.firstName, appleMeta.name.lastName].filter(Boolean).join(" ").trim() || undefined;
    }

    const email = appleUser.email || (appleMeta && appleMeta.email);
    const user = await findOrCreateUserWithIdentity({
      provider: "apple",
      providerUserId: appleUser.sub,
      email,
      emailVerified: appleUser.emailVerified,
      name: fullName,
      isPrivateEmail: appleUser.isPrivateEmail,
    });

    const { accessToken, refreshToken } = await createSession(
      user.id,
      req.headers["user-agent"],
      req.ip
    );

    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());
    res.json({ accessToken, user });
  } catch (err) {
    next(err);
  }
});

// POST /auth/apple/callback
router.post("/apple/callback", async (req, res, next) => {
  try {
    const { id_token, user: rawUser } = req.body;
    if (!id_token) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "id_token is required" } });

    const appleUser = await verifyAppleIdToken(id_token);
    let appleMeta = undefined;
    if (rawUser) {
      try { appleMeta = typeof rawUser === "string" ? JSON.parse(rawUser) : rawUser; } catch (_) {}
    }

    let fullName = undefined;
    if (appleMeta && appleMeta.name) {
      fullName = [appleMeta.name.firstName, appleMeta.name.lastName].filter(Boolean).join(" ").trim() || undefined;
    }

    const email = appleUser.email || (appleMeta && appleMeta.email);
    const user = await findOrCreateUserWithIdentity({
      provider: "apple",
      providerUserId: appleUser.sub,
      email,
      emailVerified: appleUser.emailVerified,
      name: fullName,
      isPrivateEmail: appleUser.isPrivateEmail,
    });

    const { accessToken, refreshToken } = await createSession(
      user.id,
      req.headers["user-agent"],
      req.ip
    );

    res.cookie("refreshToken", refreshToken, getRefreshCookieOptions());
    res.json({ accessToken, user });
  } catch (err) {
    next(err);
  }
});

// GET /auth/apple/client-secret
router.get("/apple/client-secret", async (_req, res, next) => {
  try {
    const clientSecret = await generateAppleClientSecret();
    res.json({ clientSecret, expiresInDays: 180 });
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh
router.post("/refresh", async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies && req.cookies.refreshToken;
    if (!rawRefreshToken) {
      return res.status(401).json({ error: { code: "REFRESH_TOKEN_REQUIRED", message: "Refresh cookie missing" } });
    }

    const { accessToken, refreshToken: newRefreshToken } = await rotateRefreshToken(
      rawRefreshToken,
      req.headers["user-agent"],
      req.ip
    );

    res.cookie("refreshToken", newRefreshToken, getRefreshCookieOptions());
    res.json({ accessToken });
  } catch (err) {
    res.clearCookie("refreshToken", getRefreshCookieOptions());
    next(err);
  }
});

// POST /auth/logout
router.post("/logout", async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies && req.cookies.refreshToken;
    if (rawRefreshToken) await revokeSession(rawRefreshToken);
    res.clearCookie("refreshToken", getRefreshCookieOptions());
    res.json({ success: true, message: "Logged out" });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout-all
router.post("/logout-all", authMiddleware, async (req, res, next) => {
  try {
    await revokeAllUserSessions(req.user.id);
    res.clearCookie("refreshToken", getRefreshCookieOptions());
    res.json({ success: true, message: "All sessions revoked" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
