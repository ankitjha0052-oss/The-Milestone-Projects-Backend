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

  // Database lookup: Check users table first (for full profile data), fallback to superadmin
  try {
    const [users] = await pool.query(
      `SELECT id, name, given_name, family_name, email, email_verified, picture, locale, 
              phone, phone_verified, birthday, gender, country, timezone, location, headline, bio, profile_completed, 
              role, free_jobs_used, is_active, last_login_at, created_at, user_type 
       FROM users WHERE id = ?`,
      [payload.userId]
    );

    if (users.length > 0) {
      if (!users[0].is_active) {
        return res.status(403).json({ error: { code: "ACCOUNT_DISABLED", message: "Your account has been deactivated. Please contact support." } });
      }
      req.user = users[0];
      return next();
    }

    // Fallback: check superadmin table
    const [superadmins] = await pool.query(
      `SELECT id, name, email, login_id, role, is_active, created_at FROM superadmin WHERE id = ?`,
      [payload.userId]
    );

    if (superadmins.length > 0) {
      if (!superadmins[0].is_active) {
        return res.status(403).json({ error: { code: "ACCOUNT_DISABLED", message: "Your administrator account has been deactivated. Please contact administration." } });
      }
      req.user = {
        ...superadmins[0],
        role: superadmins[0].role || 'superadmin',
        user_type: 'superadmin',
      };
      return next();
    }

    return res.status(401).json({ error: { code: "USER_NOT_FOUND", message: "User account no longer exists" } });
  } catch (dbError) {
    console.error("Database error in authMiddleware:", dbError.message);
    next(dbError); // Forward to 500 error handler
  }
}

module.exports = authMiddleware;
