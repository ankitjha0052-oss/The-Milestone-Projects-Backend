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

      const joins =
        type === "candidate"
          ? "LEFT JOIN candidate_profiles cp ON cp.user_id = u.id"
          : `LEFT JOIN subscriptions s ON s.id = (
               SELECT s2.id FROM subscriptions s2
               WHERE s2.user_id = u.id AND s2.status = 'ACTIVE' AND s2.starts_at <= NOW() AND s2.ends_at > NOW()
               ORDER BY s2.ends_at ASC LIMIT 1
             )
             LEFT JOIN plans p ON p.id = s.plan_id`;
      const extra =
        type === "employer"
          ? `, (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id) AS jobs_count, 
             (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id AND j.status = 'ACTIVE') AS active_jobs_count,
             p.name AS plan_name,
             p.id AS plan_id,
             s.job_limit,
             s.jobs_used,
             s.starts_at AS plan_starts_at,
             s.ends_at AS plan_ends_at,
             CASE
               WHEN s.id IS NOT NULL THEN CONCAT(p.name, ' (', s.jobs_used, '/', s.job_limit, ' used)')
               WHEN (u.created_at + INTERVAL 30 DAY) > NOW() AND (u.free_jobs_used < 5 OR u.free_jobs_used IS NULL) THEN CONCAT('Free Trial (', COALESCE(u.free_jobs_used, 0), '/5 used)')
               WHEN (u.created_at + INTERVAL 30 DAY) > NOW() THEN 'Free quota exhausted'
               ELSE 'Trial expired / No plan'
             END AS plan_status`
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
         FROM candidate_experience WHERE user_id = ? ORDER BY start_date DESC`,
        [candidate.id]
      );
      experiences = exp;
    } catch (_) {}

    let educations = [];
    try {
      const [edu] = await pool.query(
        `SELECT id, degree, institute, year_of_passing FROM candidate_education WHERE user_id = ? ORDER BY year_of_passing DESC`,
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
    note ? String(note).slice(0, 255) : null,
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

    // SSE Real-Time Event Dispatch: Instantly log out the deactivated user in real-time
    try {
      const { emitToUser, emitToAdmin } = require("./events");
      emitToUser(req.params.id, {
        type: "FORCE_LOGOUT",
        reason: "ACCOUNT_DEACTIVATED",
        message: "Your account has been deactivated by administration. Please contact support at info@themilestoneprojects.co.in."
      });
      emitToAdmin({
        type: "USER_STATUS_UPDATED",
        userId: req.params.id,
        is_active: false
      });
    } catch (_) {}

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

    try {
      const { emitToAdmin } = require("./events");
      emitToAdmin({
        type: "USER_STATUS_UPDATED",
        userId: req.params.id,
        is_active: true
      });
    } catch (_) {}

    res.json({ success: true, message: "User account activated successfully." });
  } catch (err) {
    next(err);
  }
});

// GET /admin/plans -> Fetch all available plans for superadmin assignment
router.get("/plans", guard, async (req, res, next) => {
  try {
    const [plans] = await pool.query(
      "SELECT id, name, price_paise, job_limit, duration_days, is_active FROM plans WHERE is_active = TRUE ORDER BY id ASC"
    );
    res.json({ success: true, data: plans });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users/:id/assign-plan -> Super admin grants/changes plan for an employer or user
router.post("/users/:id/assign-plan", guard, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { plan_id, duration_days, job_limit, note } = req.body;
    if (!plan_id) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Plan ID is required." } });
    }

    const [users] = await conn.query("SELECT id, name, email, user_type, is_active FROM users WHERE id = ?", [req.params.id]);
    if (users.length === 0) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "User account could not be found." } });
    }
    const user = users[0];

    if (user.user_type !== "employer") {
      return res.status(400).json({ error: { code: "NOT_EMPLOYER", message: "Plans can be assigned to employer accounts only." } });
    }

    const [plans] = await conn.query("SELECT * FROM plans WHERE id = ?", [plan_id]);
    if (plans.length === 0) {
      return res.status(400).json({ error: { code: "INVALID_PLAN", message: "Selected plan does not exist." } });
    }
    const plan = plans[0];

    const customDuration = parseInt(duration_days, 10);
    const customJobLimit = parseInt(job_limit, 10);
    const finalDurationDays = customDuration > 0 ? customDuration : plan.duration_days;
    const finalJobLimit = customJobLimit > 0 ? customJobLimit : plan.job_limit;

    await conn.beginTransaction();

    const orderId = crypto.randomUUID();
    const razorpayOrderId = `ADMIN_ASSIGNED_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const razorpayPaymentId = `ADMIN_${crypto.randomUUID()}`;
    const adminId = req.user && req.user.id ? req.user.id : "superadmin";

    // Insert order record for complete audit trail with unique payment ID
    await conn.query(
      "INSERT INTO orders (id, user_id, plan_id, razorpay_order_id, razorpay_payment_id, amount_paise, status, created_at, paid_at) VALUES (?, ?, ?, ?, ?, 0, 'PAID', NOW(), NOW())",
      [orderId, user.id, plan.id, razorpayOrderId, razorpayPaymentId]
    );

    const { startSubscription } = require("./subscriptionHelper");
    const sub = await startSubscription(conn, {
      userId: user.id,
      plan,
      orderId,
      jobLimit: finalJobLimit,
      durationDays: finalDurationDays,
    });

    await conn.commit();

    // Log superadmin action
    await logAction(
      adminId,
      "ASSIGN_PLAN",
      `Assigned ${plan.name} (${finalJobLimit} posts, ${finalDurationDays}d) to ${user.email}. ${note ? `Note: ${note}` : ''}`
    );

    // Emit live SSE events
    try {
      const { emitToUser, emitToAdmin } = require("./events");
      emitToUser(user.id, {
        type: "PLAN_ACTIVATED",
        planName: plan.name,
        endsAt: sub.endsAt,
        jobLimit: finalJobLimit,
      });
      emitToAdmin({
        type: "USER_STATUS_UPDATED",
        userId: user.id,
        plan_name: plan.name,
      });
    } catch (_) {}

    const responseMsg = sub.startsNow
      ? `Plan "${plan.name}" activated from today for ${user.name || user.email}.`
      : `Plan "${plan.name}" queued for ${user.name || user.email}, starts on ${new Date(sub.startsAt).toLocaleDateString('en-IN')}.`;

    res.json({
      success: true,
      message: responseMsg,
      data: {
        subscription_id: sub.subId,
        user_id: user.id,
        plan_name: plan.name,
        job_limit: finalJobLimit,
        duration_days: finalDurationDays,
        starts_at: sub.startsAt,
        ends_at: sub.endsAt,
        starts_now: sub.startsNow,
        upgrade_now: sub.upgradeNow,
      },
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
