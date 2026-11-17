const { sequelize, User, AuthIdentity, RefreshToken } = require("../models");
const {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  getRefreshTokenExpiryDate,
} = require("../utils/token");

/**
 * Find or create user adhering strictly to:
 * 1. Identify by (provider, provider_user_id = sub), NEVER by email alone
 * 2. If a verified email matches an existing user, link the new provider to that user
 * 3. Never overwrite user's name if already set
 */
async function findOrCreateUserWithIdentity(profile) {
  const {
    provider,
    providerUserId,
    email,
    emailVerified,
    name,
    picture,
    locale,
    isPrivateEmail,
  } = profile;

  return await sequelize.transaction(async (t) => {
    // 1. Identify strictly by (provider, providerUserId)
    const existingIdentity = await AuthIdentity.findOne({
      where: { provider, providerUserId },
      include: [{ model: User, as: "user" }],
      transaction: t,
    });

    if (existingIdentity && existingIdentity.user) {
      const user = existingIdentity.user;
      const updates = {};
      if (!user.picture && picture) updates.picture = picture;
      if (!user.locale && locale) updates.locale = locale;
      if (!user.name && name) updates.name = name;
      if (!user.emailVerified && emailVerified && email) {
        updates.email = email;
        updates.emailVerified = true;
      }

      if (Object.keys(updates).length > 0) {
        await user.update(updates, { transaction: t });
      }

      return user.toJSON();
    }

    // 2. Identity not found. Link if verified email matches an existing user
    let user = null;
    if (email && emailVerified) {
      user = await User.findOne({
        where: { email, emailVerified: true },
        transaction: t,
      });
    }

    if (!user) {
      user = await User.create(
        {
          name: name || null,
          email: email || null,
          emailVerified: Boolean(emailVerified),
          picture: picture || null,
          locale: locale || null,
        },
        { transaction: t }
      );
    }

    // 3. Create identity record linked to the user
    await AuthIdentity.create(
      {
        userId: user.id,
        provider,
        providerUserId,
        email: email || null,
        isPrivateEmail: Boolean(isPrivateEmail),
      },
      { transaction: t }
    );

    return user.toJSON();
  });
}

/**
 * Issue new access + refresh token and store refresh token hash in DB
 */
async function createSession(userId, deviceInfo, ip) {
  const accessToken = generateAccessToken(userId);
  const refreshToken = generateRefreshToken();
  const tokenHash = hashToken(refreshToken);
  const expiresAt = getRefreshTokenExpiryDate();

  await RefreshToken.create({
    userId,
    tokenHash,
    expiresAt,
    revoked: false,
    deviceInfo: deviceInfo || null,
    ip: ip || null,
  });

  return { accessToken, refreshToken };
}

/**
 * Token Rotation & Theft Detection:
 * - Issues new access token + new refresh token, revokes the old one
 * - If an already-revoked refresh token is reused, revoke ALL sessions of that user
 */
async function rotateRefreshToken(rawRefreshToken, deviceInfo, ip) {
  const currentTokenHash = hashToken(rawRefreshToken);

  const existingToken = await RefreshToken.findOne({
    where: { tokenHash: currentTokenHash },
  });

  if (!existingToken) {
    const error = new Error("Invalid refresh token");
    error.code = "INVALID_REFRESH_TOKEN";
    error.statusCode = 401;
    throw error;
  }

  // Theft detection: token was already revoked!
  if (existingToken.revoked) {
    console.warn(`[Security Alert] Replay of revoked token detected for user ${existingToken.userId}. Revoking all sessions.`);
    await RefreshToken.update(
      { revoked: true },
      { where: { userId: existingToken.userId } }
    );
    const error = new Error("Refresh token reuse detected. All sessions invalidated for security.");
    error.code = "TOKEN_REUSE_DETECTED";
    error.statusCode = 401;
    throw error;
  }

  // Check expiry
  if (new Date() > new Date(existingToken.expiresAt)) {
    await existingToken.update({ revoked: true });
    const error = new Error("Refresh token has expired");
    error.code = "REFRESH_TOKEN_EXPIRED";
    error.statusCode = 401;
    throw error;
  }

  const newAccessToken = generateAccessToken(existingToken.userId);
  const newRefreshToken = generateRefreshToken();
  const newTokenHash = hashToken(newRefreshToken);
  const newExpiresAt = getRefreshTokenExpiryDate();

  await sequelize.transaction(async (t) => {
    // Revoke old token and track replacedBy
    await existingToken.update(
      {
        revoked: true,
        replacedBy: newTokenHash,
      },
      { transaction: t }
    );

    // Create new token
    await RefreshToken.create(
      {
        userId: existingToken.userId,
        tokenHash: newTokenHash,
        expiresAt: newExpiresAt,
        revoked: false,
        deviceInfo: deviceInfo || existingToken.deviceInfo,
        ip: ip || existingToken.ip,
      },
      { transaction: t }
    );
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    userId: existingToken.userId,
  };
}

/**
 * Revoke single session
 */
async function revokeSession(rawRefreshToken) {
  const tokenHash = hashToken(rawRefreshToken);
  await RefreshToken.update({ revoked: true }, { where: { tokenHash } });
}

/**
 * Revoke all sessions for a user
 */
async function revokeAllUserSessions(userId) {
  await RefreshToken.update({ revoked: true }, { where: { userId } });
}

module.exports = {
  findOrCreateUserWithIdentity,
  createSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
};
