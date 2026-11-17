const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../config/env");

/**
 * Access token: 15-minute validity with { userId } payload
 */
function generateAccessToken(userId) {
  return jwt.sign({ userId }, config.accessTokenSecret, {
    expiresIn: "15m",
  });
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.accessTokenSecret);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      const error = new Error("Access token has expired");
      error.code = "TOKEN_EXPIRED";
      error.statusCode = 401;
      throw error;
    }
    const error = new Error("Invalid access token");
    error.code = "INVALID_TOKEN";
    error.statusCode = 401;
    throw error;
  }
}

/**
 * Refresh token: cryptographically secure 64-byte hex string (30 days validity)
 */
function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

/**
 * SHA-256 hash of refresh token for database storage
 */
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getRefreshTokenExpiryDate() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date;
}

module.exports = {
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  getRefreshTokenExpiryDate,
};
