const { User } = require("../models");
const { verifyAccessToken } = require("../utils/token");

/**
 * Authentication Middleware:
 * Verifies Bearer access token, attaches req.user.
 * When expired, returns HTTP 401 with code "TOKEN_EXPIRED".
 */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid Authorization header",
      },
    });
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Bearer token cannot be empty",
      },
    });
  }

  try {
    const payload = verifyAccessToken(token);

    const user = await User.findByPk(payload.userId, {
      attributes: [
        "id",
        "name",
        "email",
        "emailVerified",
        "picture",
        "locale",
        "phone",
        "birthday",
      ],
    });

    if (!user) {
      return res.status(401).json({
        error: {
          code: "USER_NOT_FOUND",
          message: "User account no longer exists",
        },
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.code === "TOKEN_EXPIRED") {
      return res.status(401).json({
        error: {
          code: "TOKEN_EXPIRED",
          message: "Access token has expired",
        },
      });
    }

    return res.status(401).json({
      error: {
        code: "INVALID_TOKEN",
        message: error.message || "Invalid token",
      },
    });
  }
}

module.exports = authMiddleware;
