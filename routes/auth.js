const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  getRefreshCookieOptions,
  verifyGoogleIdToken,
  verifyAppleIdToken,
  findOrCreateUserWithIdentity,
  createSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
  USER_REFRESH_COOKIE,
} = require("./authHelper");
const authMiddleware = require("./authMiddleware");
const pool = require("./pool");

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
    const userType = req.body.userType === 'employer' ? 'employer' : 'candidate';
    const user = await findOrCreateUserWithIdentity({
      provider: "google",
      providerUserId: googleUser.sub,
      email: googleUser.email,
      emailVerified: googleUser.emailVerified,
      name: googleUser.name,
      givenName: googleUser.givenName,
      familyName: googleUser.familyName,
      picture: googleUser.picture,
      locale: googleUser.locale,
      userType,
    });

    const { accessToken, refreshToken } = await createSession(
      user.id,
      req.headers["user-agent"],
      req.ip
    );

    res.cookie(USER_REFRESH_COOKIE, refreshToken, getRefreshCookieOptions());
    res.json({ accessToken, user });
  } catch (err) {
    next(err);
  }
});

// 2. POST /auth/apple (Fix 6: Always trust verified token email, NOT client req.body.user.email)
router.post("/apple", async (req, res, next) => {
  try {
    const { idToken, user: appleMeta } = req.body;
    if (!idToken) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "idToken is required" } });

    const appleUser = await verifyAppleIdToken(idToken);

    // Name is sent by Apple only on first sign in
    let fullName = undefined;
    let firstName = undefined;
    let lastName = undefined;
    if (appleMeta && appleMeta.name) {
      firstName = appleMeta.name.firstName;
      lastName = appleMeta.name.lastName;
      fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || undefined;
    }

    // Security: Only verified email from Apple's signed JWT is trusted
    const user = await findOrCreateUserWithIdentity({
      provider: "apple",
      providerUserId: appleUser.sub,
      email: appleUser.email,
      emailVerified: appleUser.emailVerified,
      name: fullName,
      givenName: firstName,
      familyName: lastName,
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

// Fix 5: Apple Form POST Callback (Redirects to frontend with refresh cookie set)
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
    let firstName = undefined;
    let lastName = undefined;
    if (appleMeta && appleMeta.name) {
      firstName = appleMeta.name.firstName;
      lastName = appleMeta.name.lastName;
      fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || undefined;
    }

    const user = await findOrCreateUserWithIdentity({
      provider: "apple",
      providerUserId: appleUser.sub,
      email: appleUser.email, // Never client email
      emailVerified: appleUser.emailVerified,
      name: fullName,
      givenName: firstName,
      familyName: lastName,
      isPrivateEmail: appleUser.isPrivateEmail,
    });

    const { refreshToken } = await createSession(
      user.id,
      req.headers["user-agent"],
      req.ip
    );

    res.cookie(USER_REFRESH_COOKIE, refreshToken, getRefreshCookieOptions());

    // Redirect smoothly to frontend auth success page
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${frontendUrl}/auth/success`);
  } catch (err) {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${frontendUrl}/auth/error?message=${encodeURIComponent(err.message)}`);
  }
});

// Note on Fix 1: /auth/apple/client-secret route has been permanently removed for security.

// 3. POST /auth/refresh (Multi-tab safe with grace period - strictly for Candidates & Employers)
router.post("/refresh", async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies && (req.cookies[USER_REFRESH_COOKIE] || req.cookies.refreshToken);
    if (!rawRefreshToken) {
      return res.status(401).json({ error: { code: "REFRESH_TOKEN_REQUIRED", message: "Refresh cookie missing" } });
    }

    const { accessToken, refreshToken: newRefreshToken, userId } = await rotateRefreshToken(
      rawRefreshToken,
      req.headers["user-agent"],
      req.ip
    );

    if (newRefreshToken) {
      res.cookie(USER_REFRESH_COOKIE, newRefreshToken, getRefreshCookieOptions());
    }

    // Strictly lookup candidate/employer in users table ONLY
    const [users] = await pool.query(
      "SELECT id, name, email, role, user_type, is_active FROM users WHERE id = ? AND is_active = TRUE",
      [userId]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: { code: "USER_NOT_FOUND", message: "User account no longer exists" } });
    }

    const user = {
      id: users[0].id,
      name: users[0].name,
      email: users[0].email,
      role: users[0].role || 'user',
      user_type: users[0].user_type || 'candidate',
    };

    res.json({ accessToken, user });
  } catch (err) {
    res.clearCookie(USER_REFRESH_COOKIE, getRefreshCookieOptions());
    next(err);
  }
});

// 4. POST /auth/logout (Candidate & Employer)
router.post("/logout", async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies && (req.cookies[USER_REFRESH_COOKIE] || req.cookies.refreshToken);
    if (rawRefreshToken) await revokeSession(rawRefreshToken);
    res.clearCookie(USER_REFRESH_COOKIE, getRefreshCookieOptions());
    res.json({ success: true, message: "Logged out" });
  } catch (err) {
    next(err);
  }
});

// 5. POST /auth/logout-all
router.post("/logout-all", authMiddleware, async (req, res, next) => {
  try {
    await revokeAllUserSessions(req.user.id);
    res.clearCookie(USER_REFRESH_COOKIE, getRefreshCookieOptions());
    res.json({ success: true, message: "All sessions revoked" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
