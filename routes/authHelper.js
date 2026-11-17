const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const jwksClient = require("jwks-rsa");
const pool = require("./pool");
require("dotenv").config();

// Fix 2: Never allow fallback secret - fail fast if missing in production
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
if (!ACCESS_TOKEN_SECRET) {
  throw new Error("FATAL: ACCESS_TOKEN_SECRET environment variable is missing!");
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || "";
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const appleJwks = jwksClient({
  jwksUri: "https://appleid.apple.com/auth/keys",
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000,
  rateLimit: true,
});

function getAppleKey(header, callback) {
  if (!header.kid) return callback(new Error("Apple token header missing kid"));
  appleJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// 15-Minute Access Token
function generateAccessToken(userId) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "15m" });
}

// Access Token Verifier
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, ACCESS_TOKEN_SECRET);
  } catch (err) {
    const error = new Error(
      err.name === "TokenExpiredError" ? "Access token has expired" : "Invalid access token"
    );
    error.code = err.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "INVALID_TOKEN";
    error.statusCode = 401;
    throw error;
  }
}

// Random 64-byte Refresh Token
function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

// SHA-256 Hash of token
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Fix 8: Cookie configuration with proper sameSite and domain handling
function getRefreshCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

  return {
    httpOnly: true,
    secure: isProduction,
    // If same parent domain is configured, use lax; otherwise none for cross-domain HTTPS
    sameSite: cookieDomain ? "lax" : (isProduction ? "none" : "lax"),
    domain: cookieDomain,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/auth",
  };
}

// Google Verification with extra profile claims (given_name, family_name, hd)
async function verifyGoogleIdToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const p = ticket.getPayload();
  if (!p || !p.sub || !p.email) {
    const err = new Error("Invalid Google token payload");
    err.code = "INVALID_GOOGLE_TOKEN";
    err.statusCode = 401;
    throw err;
  }
  return {
    sub: p.sub,
    email: p.email,
    emailVerified: Boolean(p.email_verified),
    name: p.name,
    givenName: p.given_name,
    familyName: p.family_name,
    picture: p.picture,
    locale: p.locale,
    hd: p.hd,
  };
}

// Apple Verification against JWKS
function verifyAppleIdToken(idToken) {
  if (!APPLE_CLIENT_ID) {
    throw new Error("APPLE_CLIENT_ID environment variable is missing!");
  }

  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      getAppleKey,
      {
        issuer: "https://appleid.apple.com",
        audience: APPLE_CLIENT_ID,
        algorithms: ["RS256"],
      },
      (err, decoded) => {
        if (err) {
          const error = new Error(`Apple verification failed: ${err.message}`);
          error.code = "INVALID_APPLE_TOKEN";
          error.statusCode = 401;
          return reject(error);
        }
        resolve({
          sub: decoded.sub,
          email: decoded.email,
          emailVerified: decoded.email_verified === true || decoded.email_verified === "true",
          isPrivateEmail: decoded.is_private_email === true || decoded.is_private_email === "true",
          nonce: decoded.nonce,
        });
      }
    );
  });
}

// Consistent User Object Formatter for both login and /me endpoints
function formatUserResponse(u) {
  return {
    id: u.id,
    name: u.name,
    givenName: u.given_name || null,
    familyName: u.family_name || null,
    email: u.email,
    emailVerified: Boolean(u.email_verified),
    picture: u.picture,
    locale: u.locale,
    phone: u.phone || null,
    phoneVerified: Boolean(u.phone_verified),
    birthday: u.birthday || null,
    gender: u.gender || null,
    country: u.country || null,
    timezone: u.timezone || null,
    profileCompleted: Boolean(u.profile_completed),
    lastLoginAt: u.last_login_at || null,
    createdAt: u.created_at,
  };
}

// User Find / Create / Link Identity wrapped in MySQL TRANSACTION
async function findOrCreateUserWithIdentity(profile) {
  const { provider, providerUserId, email, emailVerified, name, givenName, familyName, picture, locale, isPrivateEmail } = profile;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Check if identity exists by (provider, providerUserId)
    const [identities] = await connection.query(
      `SELECT ai.*, u.id as u_id, u.name as u_name, u.given_name, u.family_name, u.email as u_email, 
              u.email_verified as u_email_verified, u.picture as u_picture, u.locale as u_locale, 
              u.phone as u_phone, u.phone_verified, u.birthday as u_birthday, u.gender, u.country, 
              u.timezone, u.profile_completed, u.last_login_at, u.login_count, u.created_at
       FROM auth_identities ai 
       JOIN users u ON ai.user_id = u.id 
       WHERE ai.provider = ? AND ai.provider_user_id = ?
       FOR UPDATE`,
      [provider, providerUserId]
    );

    let finalUserId;

    if (identities.length > 0) {
      const existing = identities[0];
      finalUserId = existing.u_id;

      const updates = [];
      const updateVals = [];

      if (!existing.u_picture && picture) { updates.push("picture = ?"); updateVals.push(picture); }
      if (!existing.u_locale && locale) { updates.push("locale = ?"); updateVals.push(locale); }
      if (!existing.u_name && name) { updates.push("name = ?"); updateVals.push(name); }
      if (!existing.given_name && givenName) { updates.push("given_name = ?"); updateVals.push(givenName); }
      if (!existing.family_name && familyName) { updates.push("family_name = ?"); updateVals.push(familyName); }

      // Increment login count & track last login
      updates.push("login_count = login_count + 1");
      updates.push("last_login_at = NOW()");

      updateVals.push(finalUserId);
      await connection.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, updateVals);
    } else {
      // 2. Link by verified email if user exists
      let existingUserId = null;
      if (email && emailVerified) {
        const [existingUsers] = await connection.query(
          "SELECT id FROM users WHERE email = ? AND email_verified = TRUE FOR UPDATE",
          [email]
        );
        if (existingUsers.length > 0) {
          existingUserId = existingUsers[0].id;
        }
      }

      finalUserId = existingUserId;

      if (!finalUserId) {
        // Create new user
        finalUserId = crypto.randomUUID();
        await connection.query(
          `INSERT INTO users (id, name, given_name, family_name, email, email_verified, picture, locale, last_login_at, login_count) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 1)`,
          [finalUserId, name || null, givenName || null, familyName || null, email || null, Boolean(emailVerified), picture || null, locale || null]
        );
      } else {
        // Increment login count
        await connection.query("UPDATE users SET login_count = login_count + 1, last_login_at = NOW() WHERE id = ?", [finalUserId]);
      }

      // 3. Insert identity linked to user
      const identityId = crypto.randomUUID();
      await connection.query(
        "INSERT INTO auth_identities (id, user_id, provider, provider_user_id, email, is_private_email) VALUES (?, ?, ?, ?, ?, ?)",
        [identityId, finalUserId, provider, providerUserId, email || null, Boolean(isPrivateEmail)]
      );
    }

    await connection.commit();

    const [createdUser] = await pool.query("SELECT * FROM users WHERE id = ?", [finalUserId]);
    return formatUserResponse(createdUser[0]);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// Issue Session
async function createSession(userId, deviceInfo, ip) {
  const accessToken = generateAccessToken(userId);
  const refreshToken = generateRefreshToken();
  const tokenHash = hashToken(refreshToken);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked, device_info, ip) VALUES (?, ?, ?, ?, FALSE, ?, ?)",
    [id, userId, tokenHash, expiresAt, deviceInfo || null, ip || null]
  );

  return { accessToken, refreshToken };
}

// Fix 3: Multi-tab atomic rotation with 30-second grace period & theft detection
async function rotateRefreshToken(rawRefreshToken, deviceInfo, ip) {
  const currentTokenHash = hashToken(rawRefreshToken);
  const [tokens] = await pool.query(
    "SELECT * FROM refresh_tokens WHERE token_hash = ?",
    [currentTokenHash]
  );

  if (tokens.length === 0) {
    const error = new Error("Invalid refresh token");
    error.code = "INVALID_REFRESH_TOKEN";
    error.statusCode = 401;
    throw error;
  }

  const existingToken = tokens[0];

  // Token Theft Detection: Only alert if token was revoked MORE than 30 seconds ago
  if (existingToken.revoked) {
    const revokedAtTime = existingToken.revoked_at ? new Date(existingToken.revoked_at).getTime() : 0;
    const nowTime = Date.now();
    const gracePeriodMs = 30 * 1000; // 30 seconds grace period for parallel browser tabs

    if (nowTime - revokedAtTime > gracePeriodMs) {
      console.warn(`[Security Alert] Token reuse detected for user ${existingToken.user_id} after grace period. Invalidation triggered.`);
      await pool.query("UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?", [existingToken.user_id]);
      const error = new Error("Refresh token reuse detected. All sessions invalidated for security.");
      error.code = "TOKEN_REUSE_DETECTED";
      error.statusCode = 401;
      throw error;
    } else {
      // Inside grace period: Return the replaced_by token if available or issue new token smoothly
      const newAccessToken = generateAccessToken(existingToken.user_id);
      return {
        accessToken: newAccessToken,
        refreshToken: rawRefreshToken, // Keep session active
        userId: existingToken.user_id,
      };
    }
  }

  // Expiry check
  if (new Date() > new Date(existingToken.expires_at)) {
    await pool.query("UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = ?", [existingToken.id]);
    const error = new Error("Refresh token has expired");
    error.code = "REFRESH_TOKEN_EXPIRED";
    error.statusCode = 401;
    throw error;
  }

  const newAccessToken = generateAccessToken(existingToken.user_id);
  const newRefreshToken = generateRefreshToken();
  const newTokenHash = hashToken(newRefreshToken);

  const newExpiresAt = new Date();
  newExpiresAt.setDate(newExpiresAt.getDate() + 30);

  // Atomic conditional update: only update if revoked is still FALSE
  const [updateResult] = await pool.query(
    "UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW(), replaced_by = ? WHERE id = ? AND revoked = FALSE",
    [newTokenHash, existingToken.id]
  );

  // Race condition handled: another parallel tab just rotated it
  if (updateResult.affectedRows === 0) {
    return {
      accessToken: newAccessToken,
      refreshToken: rawRefreshToken,
      userId: existingToken.user_id,
    };
  }

  const newId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked, device_info, ip) VALUES (?, ?, ?, ?, FALSE, ?, ?)",
    [newId, existingToken.user_id, newTokenHash, newExpiresAt, deviceInfo || existingToken.device_info, ip || existingToken.ip]
  );

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    userId: existingToken.user_id,
  };
}

// Revoke single session
async function revokeSession(rawRefreshToken) {
  const tokenHash = hashToken(rawRefreshToken);
  await pool.query("UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE token_hash = ?", [tokenHash]);
}

// Revoke all sessions for user
async function revokeAllUserSessions(userId) {
  await pool.query("UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE user_id = ?", [userId]);
}

// Cron cleanup: Clean expired & revoked refresh tokens older than 60 days
async function cleanupOldRefreshTokens() {
  try {
    const [result] = await pool.query(
      "DELETE FROM refresh_tokens WHERE expires_at < NOW() OR (revoked = TRUE AND revoked_at < NOW() - INTERVAL 60 DAY)"
    );
    if (result.affectedRows > 0) {
      console.log(`Cleaned up ${result.affectedRows} expired/revoked refresh tokens.`);
    }
  } catch (err) {
    console.error("Error cleaning up old refresh tokens:", err.message);
  }
}

// Run cleanup every 24 hours
setInterval(cleanupOldRefreshTokens, 24 * 60 * 60 * 1000);

module.exports = {
  verifyAccessToken,
  getRefreshCookieOptions,
  verifyGoogleIdToken,
  verifyAppleIdToken,
  findOrCreateUserWithIdentity,
  createSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
  formatUserResponse,
};
