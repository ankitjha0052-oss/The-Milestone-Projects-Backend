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

function validateJobBody(b) {
  const title = (b.title || "").trim();
  const description = (b.description || "").trim();
  if (title.length < 3 || title.length > 200) throw httpError(400, "BAD_REQUEST", "Title 3-200 chars ka hona chahiye");
  if (description.length < 10 || description.length > 10000) throw httpError(400, "BAD_REQUEST", "Description 10-10000 chars ki honi chahiye");

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

    if (req.user.role === "superadmin" || req.user.role === "admin") {
      // Superadmin / Admin: direct live post without quota deductions
      status = (req.body.status || "ACTIVE").toUpperCase() === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "ACTIVE";
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
      if (user.free_jobs_used >= FREE_JOB_LIMIT) {
        throw httpError(402, "FREE_LIMIT_REACHED", "You have consumed all 5 free job postings. Please choose a plan to post additional vacancies.");
      }
      status = "PENDING_APPROVAL"; // admin approve karega
      mode = "free";
      await conn.query("UPDATE users SET free_jobs_used = free_jobs_used + 1 WHERE id = ?", [req.user.id]);
    }

    const [insertResult] = await conn.query(
      `INSERT INTO jobs 
       (user_id, title, company_name, category, location, job_type, salary, experience_required, posted_at, apply_by, status, vacancies_count, description, requirements, subscription_id, approved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === "ACTIVE" ? "NOW()" : "NULL"}, ?)`,
      [
        req.user.id,
        data.title,
        data.companyName,
        data.category,
        data.location,
        data.jobType,
        data.salary,
        data.experienceRequired,
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

    res.status(201).json({
      status: true,
      message: (mode === "paid" || mode === "admin") ? "Job live ho gayi" : "Job approval ke liye bhej di gayi",
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
       WHERE j.user_id = ? 
       ORDER BY j.created_at DESC`,
      [req.user.id]
    );
    res.json({ status: true, count: rows.length, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /jobs?limit=20&cursor=... -> public, sirf live jobs, cursor pagination me
jobRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    let sql =
      "SELECT id, title, company_name, category, location, job_type, salary, experience_required, vacancies_count, description, requirements, expires_at, created_at FROM jobs WHERE status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > NOW())";
    const params = [];

    if (req.query.cursor) {
      const [createdAt, id] = Buffer.from(String(req.query.cursor), "base64").toString().split("|");
      sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      params.push(createdAt, createdAt, id);
    }
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
    params.push(limit + 1);

    const [rows] = await pool.query(sql, params);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor = null;
    if (hasMore) {
      const last = data[data.length - 1];
      const ts = new Date(last.created_at).toISOString().slice(0, 19).replace("T", " ");
      nextCursor = Buffer.from(`${ts}|${last.id}`).toString("base64");
    }
    res.json({ data, nextCursor, hasMore });
  } catch (err) {
    next(err);
  }
});

// GET /jobs/all_job, /jobs/all_jobs, /jobs/fetch_all_jobs -> compatibility aliases
const handleGetAllJobs = async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM jobs ORDER BY id DESC"
    );
    res.json({ status: true, data: rows });
  } catch (err) {
    next(err);
  }
};
jobRouter.get("/fetch_all_jobs", handleGetAllJobs);
jobRouter.get("/all_job", handleGetAllJobs);
jobRouter.get("/all_jobs", handleGetAllJobs);

// GET /jobs/:id -> single job details
jobRouter.get("/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM jobs WHERE id = ?", [req.params.id]);
    if (rows.length === 0) throw httpError(404, "NOT_FOUND", "Job posting not found.");
    res.json({ status: true, data: rows[0] });
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
      // Show all jobs without status filter
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
