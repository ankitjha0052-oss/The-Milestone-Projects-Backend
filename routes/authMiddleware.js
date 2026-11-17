const pool = require("./pool");
const { verifyAccessToken } = require("./authHelper");

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } });
  }

  const token = header.substring(7).trim();
  try {
    const payload = verifyAccessToken(token);
    const [users] = await pool.query(
      "SELECT id, name, email, email_verified, picture, locale, phone, birthday FROM users WHERE id = ?",
      [payload.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
    }

    req.user = users[0];
    next();
  } catch (error) {
    return res.status(401).json({
      error: { code: error.code || "INVALID_TOKEN", message: error.message },
    });
  }
}

module.exports = authMiddleware;
