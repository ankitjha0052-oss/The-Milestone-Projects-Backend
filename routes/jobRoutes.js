const express = require("express");
const crypto = require("crypto");
const pool = require("./pool");
const authMiddleware = require("./authMiddleware");

const FREE_JOB_LIMIT = 5;          // free me max 5 jobs
const FREE_WINDOW_DAYS = 30;       // signup ke 30 din tak hi free posting
const FREE_JOB_VALID_DAYS = 15;    // free job approve ke baad 15 din live

function httpError(status, code, message) {
  const e = new Error(message);
  e.statusCode = status;
  e.code = code;
  return e;
}

function sendError(res, err, next) {
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
  }
  next(err);
}

// authMiddleware ke SELECT me `role` bhi hona zaroori hai
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Access denied" } });
    }
    next();
  };
}

function cleanSalary(b) {
  let sal = b.salary ? String(b.salary).trim() : null;
  if (!sal && (b.salary_min || b.salary_max || b.min_salary || b.max_salary)) {
    const min = b.salary_min || b.min_salary || "";
    const max = b.salary_max || b.max_salary || "";
    if (min && max) sal = `₹ ${min} - ₹ ${max}`;
    else if (min) sal = `₹ ${min}+`;
    else if (max) sal = `Up to ₹ ${max}`;
  }
  if (sal) {
    sal = sal
      .replace(/[\s\/\-]+(p\.?a\.?|per\s*annum)[\.\s]*$/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return sal || "Best in Industry";
}

const EXP_MAP = {
  'Freshers Welcome': [0, 12],
  '1-3 Years': [12, 36],
  '3-5 Years': [36, 60],
  '5-8 Years': [60, 96],
  '8+ Years (Lead / Director)': [96, null],
};

function validateJobBody(b) {
  const title = (b.title || "").trim();
  const description = (b.description || "").trim();
  if (title.length < 3 || title.length > 200) throw httpError(400, "BAD_REQUEST", "Job title must be between 3 and 200 characters in length.");
  if (description.length < 10 || description.length > 10000) throw httpError(400, "BAD_REQUEST", "Job description must be between 10 and 10,000 characters in length.");

  return {
    title,
    description,
    companyName: (b.company_name || b.companyName || "").trim() || null,
    category: (b.category || "IT & Software Development").trim(),
    location: b.location ? String(b.location).slice(0, 150) : null,
    jobType: b.job_type || b.jobType ? String(b.job_type || b.jobType).slice(0, 50) : "Full-time Permanent",
    salary: cleanSalary(b),
    experienceRequired: b.experience_required || b.expRequired || "1-3 Years",
    postedAt: b.posted_at || b.postedAt || new Date().toISOString().split("T")[0],
    applyBy: b.apply_by || b.applyBy || null,
    vacancies: parseInt(b.vacancies_count || b.vacancies || 1, 10) || 1,
    requirements: b.requirements ? String(b.requirements).trim() : null,
  };
}

// =====================================================================
// USER / PUBLIC ROUTES  (mount: app.use("/jobs", jobRouter))
// =====================================================================
const jobRouter = express.Router();

// POST /jobs or POST /jobs/add_job -> quota logic & posting
const handleCreateJobPost = async (req, res, next) => {
  let conn;
  try {
    const data = validateJobBody(req.body);
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // User row lock: 2 tabs se ek saath post karne pe limit cross na ho
    const [users] = await conn.query(
      "SELECT id, free_jobs_used, (created_at + INTERVAL ? DAY) > NOW() AS in_free_window FROM users WHERE id = ? FOR UPDATE",
      [FREE_WINDOW_DAYS, req.user.id]
    );
    const user = users[0];

    const [subs] = await conn.query(
      "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'ACTIVE' AND starts_at <= NOW() AND ends_at > NOW() ORDER BY ends_at ASC LIMIT 1 FOR UPDATE",
      [req.user.id]
    );

    let status, subscriptionId = null, expiresAtSql = null, mode;
    const requestedStatus = String(req.body.status || "").trim().toUpperCase();
    const isDraft = requestedStatus === "DRAFT";

    if (isDraft) {
      // DRAFT: no quota deduction, saved as draft
      status = "DRAFT";
      mode = "draft";
      expiresAtSql = null;
      subscriptionId = null;
    } else if (req.user.role === "superadmin" || req.user.role === "admin") {
      // Superadmin / Admin: direct live post without quota deductions
      status = requestedStatus === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "ACTIVE";
      expiresAtSql = data.applyBy || null;
      mode = "admin";
    } else if (subs.length > 0) {
      const sub = subs[0];
      if (sub.jobs_used >= sub.job_limit) {
        throw httpError(402, "PLAN_LIMIT_REACHED", "You have reached the maximum job posting limit for your plan. Please upgrade to post additional vacancies.");
      }
      // PAID: directly live for duration of subscription
      status = "ACTIVE";
      subscriptionId = sub.id;
      expiresAtSql = sub.ends_at;
      mode = "paid";
      await conn.query("UPDATE subscriptions SET jobs_used = jobs_used + 1 WHERE id = ?", [sub.id]);
    } else {
      // FREE: check 30 days & 5 limit
      if (!user.in_free_window) {
        throw httpError(402, "FREE_PERIOD_ENDED", "Your 30-day free trial period has concluded. Please subscribe to a plan to continue posting vacancies.");
      }

      // Real-time count check guarantees no counter drift or legacy bypass can exceed 5 free jobs
      const [[{ actualFreeJobs }]] = await conn.query(
        "SELECT COUNT(*) AS actualFreeJobs FROM jobs WHERE user_id = ? AND (subscription_id IS NULL OR subscription_id = '')",
        [req.user.id]
      );
      const effectiveUsed = Math.max(Number(user.free_jobs_used) || 0, Number(actualFreeJobs) || 0);

      if (effectiveUsed >= FREE_JOB_LIMIT) {
        if ((user.free_jobs_used || 0) < effectiveUsed) {
          await conn.query("UPDATE users SET free_jobs_used = ? WHERE id = ?", [effectiveUsed, req.user.id]);
        }
        throw httpError(402, "FREE_LIMIT_REACHED", "You have consumed all 5 free job postings. Please choose a plan to post additional vacancies.");
      }

      status = "PENDING_APPROVAL"; // admin approve karega
      mode = "free";
      const nextUsed = effectiveUsed + 1;
      await conn.query("UPDATE users SET free_jobs_used = ? WHERE id = ?", [nextUsed, req.user.id]);
    }

    const [expMin, expMax] = EXP_MAP[data.experienceRequired] || [null, null];

    const [insertResult] = await conn.query(
      `INSERT INTO jobs 
       (user_id, title, company_name, category, location, job_type, salary, experience_required, exp_min_months, exp_max_months, posted_at, apply_by, status, vacancies_count, description, requirements, subscription_id, approved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === "ACTIVE" ? "NOW()" : "NULL"}, ?)`,
      [
        req.user.id,
        data.title,
        data.companyName,
        data.category,
        data.location,
        data.jobType,
        data.salary,
        data.experienceRequired,
        expMin,
        expMax,
        data.postedAt,
        data.applyBy,
        status,
        data.vacancies,
        data.description,
        data.requirements,
        subscriptionId,
        expiresAtSql,
      ]
    );

    const newJobId = insertResult.insertId;
    await conn.commit();

    let responseMsg = "Job approval ke liye bhej di gayi";
    if (mode === "draft") responseMsg = "Job saved as draft";
    else if (mode === "paid" || mode === "admin") responseMsg = "Job live ho gayi";

    res.status(201).json({
      status: true,
      message: responseMsg,
      job_id: newJobId,
      job: {
        id: newJobId,
        user_id: req.user.id,
        title: data.title,
        company_name: data.companyName,
        category: data.category,
        location: data.location,
        job_type: data.jobType,
        salary: data.salary,
        experience_required: data.experienceRequired,
        posted_at: data.postedAt,
        apply_by: data.applyBy,
        vacancies_count: data.vacancies,
        description: data.description,
        requirements: data.requirements,
        status,
        expires_at: expiresAtSql
      }
    });
  } catch (err) {
    if (conn) await conn.rollback();
    sendError(res, err, next);
  } finally {
    if (conn) conn.release();
  }
};

jobRouter.post("/", authMiddleware, handleCreateJobPost);
jobRouter.post("/add_job", authMiddleware, handleCreateJobPost);
jobRouter.post("/create", authMiddleware, handleCreateJobPost);

// GET /jobs/mine -> user ki apni saari jobs with FULL details
jobRouter.get("/mine", authMiddleware, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
        j.*,
        COALESCE((SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id), j.applicants_count, 0) AS applicants_count
       FROM jobs j 
       WHERE j.user_id = ? AND j.status != 'DELETED'
       ORDER BY j.created_at DESC`,
      [req.user.id]
    );
    res.json({ status: true, count: rows.length, data: rows });
  } catch (err) {
    next(err);
  }
});

const PUBLIC_JOB_COLUMNS = "id, title, company_name, category, location, job_type, salary, experience_required, exp_min_months, exp_max_months, vacancies_count, description, requirements, DATE_FORMAT(posted_at,'%Y-%m-%d') AS posted_at, DATE_FORMAT(apply_by,'%Y-%m-%d') AS apply_by, expires_at, created_at";
const LIVE = "status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > NOW())";
const list = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);

// Shared filter builder (website aur app dono use karenge)
function buildJobWhere(q, { stretch = 0 } = {}) {
  const w = [LIVE], p = [];
  if (q.q) { const s = `%${String(q.q).trim().slice(0, 100)}%`; w.push("(title LIKE ? OR company_name LIKE ? OR description LIKE ?)"); p.push(s, s, s); }
  if (q.category) { w.push("category IN (?)"); p.push(list(q.category)); }
  if (q.job_type) { w.push("job_type IN (?)"); p.push(list(q.job_type)); }
  if (q.location) { w.push("location LIKE ?"); p.push(`%${String(q.location).trim().slice(0, 100)}%`); }
  const e = parseInt(q.exp, 10); // exp = months
  if (Number.isInteger(e) && e >= 0) {
    w.push("(exp_min_months IS NULL OR exp_min_months <= ?) AND (exp_max_months IS NULL OR exp_max_months >= ?)");
    p.push(e + stretch, e);
  }
  return { where: w.join(" AND "), params: p };
}

// 1) WEBSITE: GET /jobs?q=&category=&job_type=&location=&exp=&page=1&limit=15
jobRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 50);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const { where, params } = buildJobWhere(req.query);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM jobs WHERE ${where}`, params);
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ data: rows, total, page, limit, hasMore: page * limit < total });
  } catch (err) { next(err); }
});

// 2) FILTER OPTIONS: GET /jobs/filters
jobRouter.get("/filters", async (_req, res, next) => {
  try {
    const q = (col) => pool.query(`SELECT ${col} AS value, COUNT(*) AS count FROM jobs WHERE ${LIVE} AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY count DESC LIMIT 30`);
    const [[categories], [job_types], [locations]] = await Promise.all([q("category"), q("job_type"), q("location")]);
    res.json({ categories, job_types, locations });
  } catch (err) { next(err); }
});

// 3) APP: GET /jobs/recommended?page=1&limit=15  (+ same filters optional)
jobRouter.get("/recommended", authMiddleware, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 50);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const [pr] = await pool.query("SELECT total_exp_months, current_city, skills FROM candidate_profiles WHERE user_id = ?", [req.user.id]);
    const prof = pr[0] || {};
    const exp = prof.total_exp_months; // null = profile me experience nahi bhara
    let skills = prof.skills || [];
    if (typeof skills === "string") { try { skills = JSON.parse(skills); } catch { skills = []; } }
    skills = skills.map((s) => String(s).toLowerCase());
    const city = String(prof.current_city || "").toLowerCase();

    // experience: +12 month stretch upar, taaki 1 saal upar ki jobs bhi dikhein
    const { where, params } = buildJobWhere({ ...req.query, exp: exp ?? undefined }, { stretch: 12 });
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params
    );
    const [apps] = await pool.query("SELECT job_id FROM applications WHERE email = ?", [req.user.email]);
    const applied = new Set(apps.map((a) => a.job_id));

    const scored = rows.map((j) => {
      const text = `${j.title} ${j.requirements || ""} ${j.description || ""}`.toLowerCase();
      let score = Math.min(skills.filter((s) => text.includes(s)).length, 5) * 10; // skills match
      if (city && String(j.location || "").toLowerCase().includes(city)) score += 20; // same city
      const inRange = exp != null && (j.exp_min_months == null || j.exp_min_months <= exp) && (j.exp_max_months == null || j.exp_max_months >= exp);
      if (inRange) score += 30; // exact experience band
      return { ...j, match_score: score, applied: applied.has(j.id) };
    }).sort((a, b) => b.match_score - a.match_score || new Date(b.created_at) - new Date(a.created_at));

    res.json({
      data: scored.slice((page - 1) * limit, page * limit),
      total: scored.length, page, limit, hasMore: page * limit < scored.length,
      personalized: exp != null, // false = app me "profile me experience add karo" nudge dikhao
    });
  } catch (err) { next(err); }
});

// GET /jobs/all_job, /jobs/all_jobs, /jobs/fetch_all_jobs -> compatibility aliases (strictly ACTIVE and non-expired)
const handleGetAllJobs = async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs WHERE ${LIVE} ORDER BY id DESC`
    );
    res.json({ status: true, data: rows });
  } catch (err) {
    next(err);
  }
};
jobRouter.get("/fetch_all_jobs", handleGetAllJobs);
jobRouter.get("/all_job", handleGetAllJobs);
jobRouter.get("/all_jobs", handleGetAllJobs);

// GET /jobs/:id -> single job details (public if ACTIVE, or accessible to owner/admin)
jobRouter.get("/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM jobs WHERE id = ?", [req.params.id]);
    if (rows.length === 0) throw httpError(404, "NOT_FOUND", "Job posting not found.");
    const job = rows[0];

    const isLive = job.status === "ACTIVE" && (!job.expires_at || new Date(job.expires_at) > new Date());
    if (isLive) {
      return res.json({ status: true, data: job });
    }

    // If job is not currently active, allow if request is from the job's owner or an admin
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      try {
        const { verifyAccessToken } = require("./authHelper");
        const payload = verifyAccessToken(header.substring(7).trim());
        if (payload && payload.userId) {
          if (job.user_id === payload.userId) {
            return res.json({ status: true, data: job });
          }
          const [superadmins] = await pool.query("SELECT id FROM superadmin WHERE id = ?", [payload.userId]);
          if (superadmins.length > 0) {
            return res.json({ status: true, data: job });
          }
        }
      } catch (_) {}
    }

    throw httpError(404, "NOT_FOUND", "Job posting not found.");
  } catch (err) {
    sendError(res, err, next);
  }
});

// =====================================================================
// ADMIN ROUTES  (mount: app.use("/admin", adminRouter))
// =====================================================================
const adminRouter = express.Router();
adminRouter.use(authMiddleware, requireRole("admin", "superadmin"));

async function logAction(adminId, action, jobId, note) {
  await pool.query(
    "INSERT INTO admin_logs (id, admin_id, action, job_id, note) VALUES (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), adminId, action, jobId, note || null]
  );
}

// GET /admin/jobs?status=PENDING_APPROVAL&q=&page=1&limit=20
adminRouter.get("/jobs", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * limit;
    const q = String(req.query.q || "").trim();
    const statusParam = req.query.status;

    const whereConditions = [];
    const params = [];

    if (statusParam === "INACTIVE") {
      whereConditions.push("j.status IN ('EXPIRED', 'CLOSED')");
    } else if (["PENDING_APPROVAL", "ACTIVE", "EXPIRED", "REJECTED", "CLOSED"].includes(statusParam)) {
      whereConditions.push("j.status = ?");
      params.push(statusParam);
    } else if (!statusParam || statusParam === "ALL") {
      whereConditions.push("j.status != 'DELETED'");
    } else {
      whereConditions.push("j.status = 'PENDING_APPROVAL'");
    }

    if (q) {
      whereConditions.push("(j.title LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR j.company_name LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM jobs j LEFT JOIN users u ON u.id = j.user_id ${whereClause}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT j.*, u.name AS user_name, u.email AS user_email
       FROM jobs j LEFT JOIN users u ON u.id = j.user_id
       ${whereClause} ORDER BY j.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ data: rows, total, page: Math.floor(offset / limit) + 1, limit });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/jobs/:id -> Soft delete job so candidate applications are preserved
adminRouter.delete("/jobs/:id", async (req, res, next) => {
  try {
    const [r] = await pool.query(
      "UPDATE jobs SET status = 'DELETED', expires_at = NOW() WHERE id = ? AND status != 'DELETED'",
      [req.params.id]
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Job not found." } });
    }
    await logAction(req.user.id, "DELETE", req.params.id);
    res.json({ success: true, message: "Job removed. Candidate applications are preserved." });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/jobs/:id/approve -> free job: 15 din ka timer ab shuru
adminRouter.patch("/jobs/:id/approve", async (req, res, next) => {
  try {
    const [r] = await pool.query(
      `UPDATE jobs SET status = 'ACTIVE', approved_by = ?, approved_at = NOW(),
         expires_at = DATE_ADD(NOW(), INTERVAL ? DAY), rejection_reason = NULL
       WHERE id = ? AND status = 'PENDING_APPROVAL'`,
      [req.user.id, FREE_JOB_VALID_DAYS, req.params.id]
    );
    if (r.affectedRows === 0) {
      return res.status(409).json({ error: { code: "NOT_PENDING", message: "The job is not in a pending review state." } });
    }
    await logAction(req.user.id, "APPROVE", req.params.id);
    res.json({ success: true, message: "Job approved and published successfully." });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/jobs/:id/reject body: { reason }
adminRouter.patch("/jobs/:id/reject", async (req, res, next) => {
  try {
    const reason = String(req.body.reason || "").slice(0, 255) || null;
    const [r] = await pool.query(
      "UPDATE jobs SET status = 'REJECTED', rejection_reason = ?, approved_by = ? WHERE id = ? AND status = 'PENDING_APPROVAL'",
      [reason, req.user.id, req.params.id]
    );
    if (r.affectedRows === 0) {
      return res.status(409).json({ error: { code: "NOT_PENDING", message: "The job is not in a pending review state." } });
    }
    await logAction(req.user.id, "REJECT", req.params.id, reason);
    res.json({ success: true, message: "The job posting has been rejected." });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/jobs/:id/activate body: { days? } -> manual activation
adminRouter.patch("/jobs/:id/activate", async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body.days, 10) || FREE_JOB_VALID_DAYS, 1), 365);
    const [r] = await pool.query(
      `UPDATE jobs SET status = 'ACTIVE', approved_by = ?, approved_at = NOW(),
         expires_at = DATE_ADD(NOW(), INTERVAL ? DAY), rejection_reason = NULL
       WHERE id = ?`,
      [req.user.id, days, req.params.id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Job posting not found." } });
    await logAction(req.user.id, "ACTIVATE", req.params.id, `${days} days`);
    res.json({ success: true, message: `The job posting has been activated for ${days} days.` });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/jobs/:id/deactivate
adminRouter.patch("/jobs/:id/deactivate", async (req, res, next) => {
  try {
    const [r] = await pool.query(
      "UPDATE jobs SET status = 'CLOSED', expires_at = NOW() WHERE id = ? AND status != 'CLOSED'",
      [req.params.id]
    );
    if (r.affectedRows === 0) {
      return res.status(409).json({ error: { code: "ALREADY_CLOSED", message: "The job posting is already closed or does not exist." } });
    }
    await logAction(req.user.id, "DEACTIVATE", req.params.id);
    res.json({ success: true, message: "The job posting has been successfully closed and deactivated." });
  } catch (err) {
    next(err);
  }
});

module.exports = { jobRouter, adminRouter, requireRole };
