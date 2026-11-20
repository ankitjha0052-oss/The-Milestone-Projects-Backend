const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const pool = require("./pool");
const authMiddleware = require("./authMiddleware");
const { requireRole } = require("./jobRoutes");
const {
  createSession,
  getRefreshCookieOptions,
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
  ADMIN_REFRESH_COOKIE,
} = require("./authHelper");

const router = express.Router();
const guard = [authMiddleware, requireRole("superadmin")];

// Timing attack prevention: runs bcrypt compare even when user is not found
const DUMMY_HASH = bcrypt.hashSync("dummy-password-not-real", 12);

// Strict rate limiter on admin login: max 8 attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many login attempts. Please try again in 15 minutes." } },
});

// POST /admin/login   body: { loginId, password }
router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const loginId = String(req.body.loginId || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!loginId || !password || password.length > 200) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Login ID and password are required." } });
    }

    // STRICTLY query superadmin table only
    const [rows] = await pool.query(
      "SELECT id, name, email, login_id, role, password_hash, is_active FROM superadmin WHERE (login_id = ? OR email = ?) AND is_active = TRUE",
      [loginId, loginId]
    );
    const u = rows[0];
    const ok = await bcrypt.compare(password, u && u.password_hash ? u.password_hash : DUMMY_HASH);

    if (!u || !ok || !u.is_active) {
      return res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid login ID or password." } });
    }

    const { accessToken, refreshToken } = await createSession(u.id, req.headers["user-agent"], req.ip);
    // Set dedicated admin cookie (never touches user_refreshToken)
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, getRefreshCookieOptions());
    res.json({ accessToken, user: { id: u.id, name: u.name, email: u.email, login_id: u.login_id, role: u.role || 'superadmin' } });
  } catch (err) {
    next(err);
  }
});

// POST /admin/refresh -> Dedicated refresh strictly for Super Admin
router.post("/refresh", async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies && req.cookies[ADMIN_REFRESH_COOKIE];
    if (!rawRefreshToken) {
      return res.status(401).json({ error: { code: "REFRESH_TOKEN_REQUIRED", message: "Admin refresh cookie missing" } });
    }

    const { accessToken, refreshToken: newRefreshToken, userId } = await rotateRefreshToken(
      rawRefreshToken,
      req.headers["user-agent"],
      req.ip
    );

    if (newRefreshToken) {
      res.cookie(ADMIN_REFRESH_COOKIE, newRefreshToken, getRefreshCookieOptions());
    }

    const [superadmins] = await pool.query(
      "SELECT id, name, email, login_id, role, is_active FROM superadmin WHERE id = ? AND is_active = TRUE",
      [userId]
    );

    if (superadmins.length === 0) {
      return res.status(403).json({ error: { code: "UNAUTHORIZED", message: "Admin account not found" } });
    }

    res.json({
      accessToken,
      user: {
        id: superadmins[0].id,
        name: superadmins[0].name,
        email: superadmins[0].email,
        login_id: superadmins[0].login_id,
        role: superadmins[0].role || 'superadmin',
      },
    });
  } catch (err) {
    res.clearCookie(ADMIN_REFRESH_COOKIE, getRefreshCookieOptions());
    next(err);
  }
});

// POST /admin/logout -> Dedicated logout strictly for Super Admin
router.post("/logout", async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies && req.cookies[ADMIN_REFRESH_COOKIE];
    if (rawRefreshToken) await revokeSession(rawRefreshToken);
    res.clearCookie(ADMIN_REFRESH_COOKIE, getRefreshCookieOptions());
    res.json({ success: true, message: "Super admin logged out" });
  } catch (err) {
    next(err);
  }
});

// GET /admin/me  -> Super Admin profile verification
router.get("/me", guard, async (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      login_id: req.user.login_id,
      role: req.user.role || 'superadmin',
      created_at: req.user.created_at,
    },
  });
});

// GET /admin/stats  -> dashboard cards
router.get("/stats", guard, async (_req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM jobs) AS total_jobs,
        (SELECT COUNT(*) FROM jobs WHERE status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > NOW())) AS active_jobs,
        (SELECT COUNT(*) FROM jobs WHERE status = 'PENDING_APPROVAL') AS pending_jobs,
        (SELECT COUNT(*) FROM jobs WHERE status IN ('EXPIRED','CLOSED','REJECTED')) AS inactive_jobs,
        (SELECT COUNT(*) FROM users WHERE user_type = 'candidate') AS total_candidates,
        (SELECT COUNT(*) FROM users WHERE user_type = 'employer') AS total_employers,
        (SELECT COUNT(*) FROM users WHERE user_type = 'employer' AND is_active = FALSE) AS inactive_employers
    `);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Users list helper (candidates / employers)
function listUsers(type) {
  return async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const offset = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * limit;
      const q = String(req.query.q || "").trim().slice(0, 100);

      let where = "u.user_type = ?";
      const params = [type];
      if (q) {
        where += " AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)";
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (req.query.active === "true") where += " AND u.is_active = TRUE";
      if (req.query.active === "false") where += " AND u.is_active = FALSE";

      const joins = type === "candidate" ? "LEFT JOIN candidate_profiles cp ON cp.user_id = u.id" : "";
      const extra =
        type === "employer"
          ? ", (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id) AS jobs_count, (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id AND j.status = 'ACTIVE') AS active_jobs_count"
          : `, cp.headline AS profile_headline, cp.summary, cp.total_exp_months, cp.current_city, cp.skills, cp.current_ctc, cp.expected_ctc, cp.notice_period_days,
             COALESCE(cp.resume_path, (SELECT a.resume_path FROM applications a WHERE a.email = u.email OR a.user_id = u.id ORDER BY a.id DESC LIMIT 1)) AS resume_path,
             (SELECT a.resume_path FROM applications a WHERE a.email = u.email OR a.user_id = u.id ORDER BY a.id DESC LIMIT 1) AS recent_resume,
             (SELECT COUNT(*) FROM applications a WHERE a.email = u.email OR a.user_id = u.id) AS applications_count,
             (SELECT a.job_title FROM applications a WHERE a.email = u.email OR a.user_id = u.id ORDER BY a.id DESC LIMIT 1) AS last_applied_job,
             (SELECT a.company_name FROM applications a WHERE a.email = u.email OR a.user_id = u.id ORDER BY a.id DESC LIMIT 1) AS last_applied_company,
             (SELECT DATE_FORMAT(a.applied_at, '%Y-%m-%d %H:%i') FROM applications a WHERE a.email = u.email OR a.user_id = u.id ORDER BY a.id DESC LIMIT 1) AS last_applied_at`;

      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users u ${joins} WHERE ${where}`, params);
      const [rows] = await pool.query(
        `SELECT u.id, u.name, u.email, u.phone, u.picture, u.location, u.headline, u.bio, u.is_active, u.profile_completed, u.created_at${extra}
         FROM users u ${joins} WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const formattedRows = rows.map((r) => {
        const resume = r.resume_path || r.recent_resume;
        return {
          ...r,
          resume_path: resume || null,
          recent_resume: resume || null,
          resumeUrl: resume ? `/resumes/${resume}` : null,
          resume_url: resume ? `/resumes/${resume}` : null,
        };
      });

      res.json({ status: true, data: formattedRows, total, page: Math.floor(offset / limit) + 1, limit });
    } catch (err) {
      next(err);
    }
  };
}

router.get("/candidates", guard, listUsers("candidate"));
router.get("/employers", guard, listUsers("employer"));

// GET /admin/candidates/:id -> Full Candidate Profile including experience, education, and applications
router.get("/candidates/:id", guard, async (req, res, next) => {
  try {
    const [users] = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.picture, u.location, u.headline, u.bio, u.is_active, u.profile_completed, u.created_at,
              cp.headline AS profile_headline, cp.summary, cp.total_exp_months, cp.current_city, cp.skills, cp.current_ctc, cp.expected_ctc, cp.notice_period_days,
              COALESCE(cp.resume_path, (SELECT a.resume_path FROM applications a WHERE a.email = u.email OR a.user_id = u.id ORDER BY a.id DESC LIMIT 1)) AS resume_path,
              (SELECT a.resume_path FROM applications a WHERE a.email = u.email OR a.user_id = u.id ORDER BY a.id DESC LIMIT 1) AS recent_resume
       FROM users u
       LEFT JOIN candidate_profiles cp ON cp.user_id = u.id
       WHERE u.id = ? AND u.user_type = 'candidate'`,
      [req.params.id]
    );
    if (!users.length) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Candidate not found." } });
    const candidate = users[0];
    const resume = candidate.resume_path || candidate.recent_resume;

    const [applications] = await pool.query(
      `SELECT a.id, a.job_id, a.job_title, a.company_name, a.resume_path, a.cover_letter, a.status,
              DATE_FORMAT(a.applied_at, '%Y-%m-%d %H:%i') AS applied_at
       FROM applications a
       WHERE a.email = ? OR a.user_id = ?
       ORDER BY a.applied_at DESC`,
      [candidate.email, candidate.id]
    );

    let experiences = [];
    try {
      const [exp] = await pool.query(
        `SELECT id, company, designation, DATE_FORMAT(start_date, '%Y-%m-%d') as start_date,
                DATE_FORMAT(end_date, '%Y-%m-%d') as end_date, is_current, description
         FROM candidate_experiences WHERE user_id = ? ORDER BY start_date DESC`,
        [candidate.id]
      );
      experiences = exp;
    } catch (_) {}

    let educations = [];
    try {
      const [edu] = await pool.query(
        `SELECT id, degree, institute, year_of_passing FROM candidate_educations WHERE user_id = ? ORDER BY year_of_passing DESC`,
        [candidate.id]
      );
      educations = edu;
    } catch (_) {}

    res.json({
      status: true,
      data: {
        ...candidate,
        resume_path: resume || null,
        recent_resume: resume || null,
        resumeUrl: resume ? `/resumes/${resume}` : null,
        resume_url: resume ? `/resumes/${resume}` : null,
        applications,
        experiences,
        educations,
      },
    });
  } catch (err) {
    next(err);
  }
});

async function logAction(adminId, action, note) {
  await pool.query("INSERT INTO admin_logs (id, admin_id, action, note) VALUES (?, ?, ?, ?)", [
    crypto.randomUUID(),
    adminId,
    action,
    note,
  ]);
}

// PATCH /admin/users/:id/deactivate
// employer ho to uski saari ACTIVE jobs bhi band (CLOSED) ho jati hain, aur wo login nahi kar payega
router.patch("/users/:id/deactivate", guard, async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT id, role, user_type FROM users WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: { code: "NOT_FOUND", message: "User account could not be found." } });
    if (rows[0].role !== "user") {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Administrator accounts cannot be deactivated." } });
    }

    await pool.query("UPDATE users SET is_active = FALSE WHERE id = ?", [req.params.id]);
    await revokeAllUserSessions(req.params.id); // Immediate session revocation
    let closedJobs = 0;
    if (rows[0].user_type === "employer") {
      const [r] = await pool.query("UPDATE jobs SET status = 'CLOSED' WHERE user_id = ? AND status = 'ACTIVE'", [req.params.id]);
      closedJobs = r.affectedRows;
    }
    await logAction(req.user.id, "USER_DEACTIVATE", `${req.params.id} (closed jobs: ${closedJobs})`);
    res.json({ success: true, closedJobs, message: "User account deactivated successfully." });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/users/:id/activate
router.patch("/users/:id/activate", guard, async (req, res, next) => {
  try {
    const [r] = await pool.query("UPDATE users SET is_active = TRUE WHERE id = ? AND role = 'user'", [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: { code: "NOT_FOUND", message: "User account could not be found." } });
    await logAction(req.user.id, "USER_ACTIVATE", req.params.id);
    res.json({ success: true, message: "User account activated successfully." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
