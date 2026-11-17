const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const jwksClient = require("jwks-rsa");
const { SignJWT, importPKCS8 } = require("jose");
const pool = require("./pool");
require("dotenv").config();

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || "";
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || "com.themilestoneprojects.web.auth";
const ACCESS_TOKEN_SECRET =
  process.env.ACCESS_TOKEN_SECRET || "default_super_secret_access_token_key_12345";

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

function getRefreshCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    domain: process.env.COOKIE_DOMAIN || undefined,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/auth",
  };
}

// Google Verification
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
    picture: p.picture,
    locale: p.locale,
  };
}

// Apple Verification against JWKS
function verifyAppleIdToken(idToken) {
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
        });
      }
    );
  });
}

// Apple client secret generator (ES256)
async function generateAppleClientSecret() {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  let privateKeyPem = process.env.APPLE_PRIVATE_KEY;

  if (!teamId || !keyId || !privateKeyPem) {
    const err = new Error("Apple credentials missing in .env");
    err.code = "MISSING_APPLE_CREDENTIALS";
    err.statusCode = 400;
    throw err;
  }

  if (!privateKeyPem.includes("\n") && privateKeyPem.includes("\\n")) {
    privateKeyPem = privateKeyPem.replace(/\\n/g, "\n");
  }

  const privateKey = await importPKCS8(privateKeyPem, "ES256");
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(now)
    .setExpirationTime(now + 180 * 24 * 60 * 60)
    .setAudience("https://appleid.apple.com")
    .setSubject(APPLE_CLIENT_ID)
    .sign(privateKey);
}

// User Find / Create / Link Identity
async function findOrCreateUserWithIdentity(profile) {
  const { provider, providerUserId, email, emailVerified, name, picture, locale, isPrivateEmail } = profile;

  // 1. Check if identity exists by (provider, providerUserId)
  const [identities] = await pool.query(
    "SELECT ai.*, u.id as u_id, u.name as u_name, u.email as u_email, u.picture as u_picture, u.locale as u_locale, u.phone as u_phone, u.birthday as u_birthday FROM auth_identities ai JOIN users u ON ai.user_id = u.id WHERE ai.provider = ? AND ai.provider_user_id = ?",
    [provider, providerUserId]
  );

  if (identities.length > 0) {
    const existing = identities[0];
    const updates = [];
    const updateVals = [];

    if (!existing.u_picture && picture) {
      updates.push("picture = ?");
      updateVals.push(picture);
    }
    if (!existing.u_locale && locale) {
      updates.push("locale = ?");
      updateVals.push(locale);
    }
    if (!existing.u_name && name) {
      updates.push("name = ?");
      updateVals.push(name);
    }

    if (updates.length > 0) {
      updateVals.push(existing.u_id);
      await pool.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, updateVals);
    }

    return {
      id: existing.u_id,
      name: existing.u_name || name,
      email: existing.u_email,
      picture: existing.u_picture || picture,
      locale: existing.u_locale || locale,
    };
  }

  // 2. Link by verified email if user exists
  let existingUserId = null;
  if (email && emailVerified) {
    const [existingUsers] = await pool.query(
      "SELECT id, name, email, picture, locale FROM users WHERE email = ? AND email_verified = TRUE",
      [email]
    );
    if (existingUsers.length > 0) {
      existingUserId = existingUsers[0].id;
    }
  }

  let finalUserId = existingUserId;

  if (!finalUserId) {
    // Create new user
    finalUserId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO users (id, name, email, email_verified, picture, locale) VALUES (?, ?, ?, ?, ?, ?)",
      [finalUserId, name || null, email || null, Boolean(emailVerified), picture || null, locale || null]
    );
  }

  // 3. Insert identity linked to user
  const identityId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO auth_identities (id, user_id, provider, provider_user_id, email, is_private_email) VALUES (?, ?, ?, ?, ?, ?)",
    [identityId, finalUserId, provider, providerUserId, email || null, Boolean(isPrivateEmail)]
  );

  const [createdUser] = await pool.query("SELECT id, name, email, picture, locale FROM users WHERE id = ?", [finalUserId]);
  return createdUser[0];
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

// Rotate Session & Theft Detection
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

  // Token Theft Detection
  if (existingToken.revoked) {
    console.warn(`[Security Alert] Token reuse detected for user ${existingToken.user_id}. Revoking ALL sessions.`);
    await pool.query("UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?", [existingToken.user_id]);
    const error = new Error("Refresh token reuse detected. All sessions invalidated for security.");
    error.code = "TOKEN_REUSE_DETECTED";
    error.statusCode = 401;
    throw error;
  }

  // Expiry check
  if (new Date() > new Date(existingToken.expires_at)) {
    await pool.query("UPDATE refresh_tokens SET revoked = TRUE WHERE id = ?", [existingToken.id]);
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

  // Revoke old token & store new one
  await pool.query(
    "UPDATE refresh_tokens SET revoked = TRUE, replaced_by = ? WHERE id = ?",
    [newTokenHash, existingToken.id]
  );

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
  await pool.query("UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = ?", [tokenHash]);
}

// Revoke all sessions for user
async function revokeAllUserSessions(userId) {
  await pool.query("UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?", [userId]);
}

module.exports = {
  verifyAccessToken,
  getRefreshCookieOptions,
  verifyGoogleIdToken,
  verifyAppleIdToken,
  generateAppleClientSecret,
  findOrCreateUserWithIdentity,
  createSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
};
