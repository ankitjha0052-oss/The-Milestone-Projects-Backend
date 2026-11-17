const { verifyGoogleIdToken } = require("../services/googleAuth.service");
const {
  verifyAppleIdToken,
  generateAppleClientSecret,
} = require("../services/appleAuth.service");
const {
  findOrCreateUserWithIdentity,
  createSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
} = require("../services/auth.service");
const {
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  REFRESH_COOKIE_NAME,
} = require("../utils/cookie");

/**
 * POST /auth/google
 */
async function googleLogin(req, res, next) {
  try {
    const { idToken } = req.body;
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

    const deviceInfo = req.headers["user-agent"] || undefined;
    const ip = req.ip || req.socket.remoteAddress || undefined;

    const { accessToken, refreshToken } = await createSession(
      user.id,
      deviceInfo,
      ip
    );

    setRefreshTokenCookie(res, refreshToken);

    res.status(200).json({
      accessToken,
      user,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /auth/apple (JSON)
 */
async function appleLogin(req, res, next) {
  try {
    const { idToken, user: appleUserMetadata } = req.body;
    const verifiedApple = await verifyAppleIdToken(idToken);

    // Save name on FIRST login only
    let fullName = undefined;
    if (appleUserMetadata && appleUserMetadata.name) {
      const { firstName, lastName } = appleUserMetadata.name;
      fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || undefined;
    }

    const email = verifiedApple.email || (appleUserMetadata && appleUserMetadata.email);

    const user = await findOrCreateUserWithIdentity({
      provider: "apple",
      providerUserId: verifiedApple.sub,
      email,
      emailVerified: verifiedApple.emailVerified,
      name: fullName,
      isPrivateEmail: verifiedApple.isPrivateEmail,
    });

    const deviceInfo = req.headers["user-agent"] || undefined;
    const ip = req.ip || req.socket.remoteAddress || undefined;

    const { accessToken, refreshToken } = await createSession(
      user.id,
      deviceInfo,
      ip
    );

    setRefreshTokenCookie(res, refreshToken);

    res.status(200).json({
      accessToken,
      user,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /auth/apple/callback (Form-urlencoded)
 */
async function appleFormCallback(req, res, next) {
  try {
    const { id_token, user: rawUser } = req.body;
    const verifiedApple = await verifyAppleIdToken(id_token);

    let appleUserMetadata = undefined;
    if (rawUser) {
      try {
        appleUserMetadata = typeof rawUser === "string" ? JSON.parse(rawUser) : rawUser;
      } catch {
        // ignore parse error if plain string
      }
    }

    let fullName = undefined;
    if (appleUserMetadata && appleUserMetadata.name) {
      const { firstName, lastName } = appleUserMetadata.name;
      fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || undefined;
    }

    const email = verifiedApple.email || (appleUserMetadata && appleUserMetadata.email);

    const user = await findOrCreateUserWithIdentity({
      provider: "apple",
      providerUserId: verifiedApple.sub,
      email,
      emailVerified: verifiedApple.emailVerified,
      name: fullName,
      isPrivateEmail: verifiedApple.isPrivateEmail,
    });

    const deviceInfo = req.headers["user-agent"] || undefined;
    const ip = req.ip || req.socket.remoteAddress || undefined;

    const { accessToken, refreshToken } = await createSession(
      user.id,
      deviceInfo,
      ip
    );

    setRefreshTokenCookie(res, refreshToken);

    res.status(200).json({
      accessToken,
      user,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /auth/refresh
 * Token rotation + theft detection
 */
async function refresh(req, res, next) {
  try {
    const rawRefreshToken = req.cookies && req.cookies[REFRESH_COOKIE_NAME];

    if (!rawRefreshToken) {
      const err = new Error("Refresh token cookie is missing");
      err.code = "REFRESH_TOKEN_REQUIRED";
      err.statusCode = 401;
      throw err;
    }

    const deviceInfo = req.headers["user-agent"] || undefined;
    const ip = req.ip || req.socket.remoteAddress || undefined;

    const { accessToken, refreshToken: newRefreshToken } = await rotateRefreshToken(
      rawRefreshToken,
      deviceInfo,
      ip
    );

    // Issue new refresh token in cookie
    setRefreshTokenCookie(res, newRefreshToken);

    res.status(200).json({
      accessToken,
    });
  } catch (error) {
    clearRefreshTokenCookie(res);
    next(error);
  }
}

/**
 * POST /auth/logout
 */
async function logout(req, res, next) {
  try {
    const rawRefreshToken = req.cookies && req.cookies[REFRESH_COOKIE_NAME];
    if (rawRefreshToken) {
      await revokeSession(rawRefreshToken);
    }
    clearRefreshTokenCookie(res);

    res.status(200).json({
      success: true,
      message: "Successfully logged out",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /auth/logout-all
 */
async function logoutAll(req, res, next) {
  try {
    if (!req.user) {
      const err = new Error("Authentication required");
      err.code = "UNAUTHORIZED";
      err.statusCode = 401;
      throw err;
    }

    await revokeAllUserSessions(req.user.id);
    clearRefreshTokenCookie(res);

    res.status(200).json({
      success: true,
      message: "All sessions have been revoked",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /auth/apple/client-secret
 */
async function getAppleClientSecret(_req, res, next) {
  try {
    const secret = await generateAppleClientSecret();
    res.status(200).json({
      clientSecret: secret,
      expiresInDays: 180,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  googleLogin,
  appleLogin,
  appleFormCallback,
  refresh,
  logout,
  logoutAll,
  getAppleClientSecret,
};
