const pool = require("./pool");
const { verifyAccessToken } = require("./authHelper");

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } });
  }

  const token = header.substring(7).trim();
  let payload;

  // Fix 7: Token verification in its OWN try/catch so DB errors don't become 401 INVALID_TOKEN
  try {
    payload = verifyAccessToken(token);
  } catch (tokenError) {
    return res.status(401).json({
      error: {
        code: tokenError.code || "INVALID_TOKEN",
        message: tokenError.message,
      },
    });
  }

  // Database lookup: Any DB error must be passed to next(err) so client gets 500, not 401 refresh loop
  try {
    const [users] = await pool.query(
      `SELECT id, name, given_name, family_name, email, email_verified, picture, locale, 
              phone, phone_verified, birthday, gender, country, timezone, profile_completed, 
              last_login_at, created_at 
       FROM users WHERE id = ?`,
      [payload.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: { code: "USER_NOT_FOUND", message: "User account no longer exists" } });
    }

    req.user = users[0];
    next();
  } catch (dbError) {
    console.error("Database error in authMiddleware:", dbError.message);
    next(dbError); // Forward to 500 error handler
  }
}

module.exports = authMiddleware;
