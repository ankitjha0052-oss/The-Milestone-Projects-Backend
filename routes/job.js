const express = require('express');
const router = express.Router();
const pool = require('./pool');
const multer = require('multer');

// Multer setup for file uploads if needed
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "public/images");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + "-" + file.originalname);
    },
});
const upload = multer({ storage: storage });

/**
 * Helper to normalize incoming job payload from frontend
 * Supports both camelCase (companyName, expRequired, jobType) and snake_case (company_name, experience_required, job_type)
 */
function cleanSalary(body) {
    let sal = body.salary ? String(body.salary).trim() : null;
    if (!sal && (body.salary_min || body.salary_max || body.min_salary || body.max_salary)) {
        const min = body.salary_min || body.min_salary || "";
        const max = body.salary_max || body.max_salary || "";
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
    return sal || 'Best in Industry';
}

function normalizeJobPayload(body) {
    return {
        title: body.title?.trim() || null,
        company_name: (body.company_name || body.companyName)?.trim() || null,
        category: (body.category || 'IT & Software Development')?.trim(),
        location: (body.location || 'Delhi NCR / Gurugram')?.trim(),
        job_type: body.job_type || body.jobType || 'Full-time Permanent',
        salary: cleanSalary(body),
        experience_required: body.experience_required || body.expRequired || '1-3 Years',
        posted_at: body.posted_at || body.postedAt || new Date().toISOString().split('T')[0],
        apply_by: body.apply_by || body.applyBy || null,
        status: body.status || 'Active',
        vacancies_count: parseInt(body.vacancies_count || body.vacancies || 1, 10) || 1,
        description: body.description?.trim() || '',
        requirements: body.requirements?.trim() || '',
        applicants_count: parseInt(body.applicants_count || 0, 10) || 0,
    };
}

/**
 * POST /job/add_job  or  POST /job/create
 * Creates a new job vacancy in the database
 */
const handleCreateJob = async (req, res) => {
    try {
        const payload = normalizeJobPayload(req.body);

        if (!payload.title || !payload.company_name) {
            return res.status(400).json({
                status: false,
                message: 'Job title and Company name are required fields',
            });
        }
        if (payload.title.length < 3 || payload.title.length > 200) {
            return res.status(400).json({
                status: false,
                message: 'Job title must be between 3 and 200 characters in length.',
            });
        }

        const [result] = await pool.query(
            `INSERT INTO jobs 
            (title, company_name, category, location, job_type, salary, experience_required, posted_at, apply_by, status, vacancies_count, description, requirements, applicants_count) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                payload.title,
                payload.company_name,
                payload.category,
                payload.location,
                payload.job_type,
                payload.salary,
                payload.experience_required,
                payload.posted_at,
                payload.apply_by,
                payload.status,
                payload.vacancies_count,
                payload.description,
                payload.requirements,
                payload.applicants_count,
            ]
        );

        const newJobId = result.insertId;

        // Fetch newly created job to return full object
        const [rows] = await pool.query("SELECT * FROM jobs WHERE id = ?", [newJobId]);

        res.status(201).json({
            status: true,
            message: 'Job Added Successfully',
            job_id: newJobId,
            job: rows[0],
        });
    } catch (error) {
        console.error("Error adding job:", error);
        res.status(500).json({ status: false, message: 'Server error while creating job post' });
    }
};

// Route aliases so both /job/add_job and /job/create work seamlessly
router.post('/add_job', upload.none(), handleCreateJob);
router.post('/create', upload.none(), handleCreateJob);
router.post('/', upload.none(), handleCreateJob);

/**
 * GET /job/fetch_all_jobs or GET /job/
 * Fetches all jobs sorted by newest first
 */
router.get("/fetch_all_jobs", async (req, res) => {
    try {
        const [jobs] = await pool.query("SELECT * FROM jobs ORDER BY id DESC");
        res.status(200).json({ status: true, data: jobs });
    } catch (error) {
        console.error("Error fetching jobs:", error);
        res.status(500).json({ status: false, message: "Internal Server Error" });
    }
});

router.get("/all_job", async (req, res) => {
    try {
        const [jobs] = await pool.query("SELECT * FROM jobs ORDER BY id DESC");
        res.status(200).json({ status: true, data: jobs });
    } catch (error) {
        console.error("Error fetching jobs:", error);
        res.status(500).json({ status: false, message: "Internal Server Error" });
    }
});

router.get("/all_jobs", async (req, res) => {
    try {
        const [jobs] = await pool.query("SELECT * FROM jobs ORDER BY id DESC");
        res.status(200).json({ status: true, data: jobs });
    } catch (error) {
        console.error("Error fetching jobs:", error);
        res.status(500).json({ status: false, message: "Internal Server Error" });
    }
});

router.get("/", async (req, res) => {
    try {
        const [jobs] = await pool.query("SELECT * FROM jobs ORDER BY id DESC");
        res.status(200).json({ status: true, data: jobs });
    } catch (error) {
        console.error("Error fetching jobs:", error);
        res.status(500).json({ status: false, message: "Internal Server Error" });
    }
});

/**
 * GET /job/:id
 * Fetch single job by ID
 */
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query("SELECT * FROM jobs WHERE id = ?", [id]);
        if (rows.length === 0) {
            return res.status(404).json({ status: false, message: "Job not found" });
        }
        res.status(200).json({ status: true, data: rows[0] });
    } catch (error) {
        console.error("Error fetching job details:", error);
        res.status(500).json({ status: false, message: "Server error" });
    }
});

/**
 * POST /job/edit_job or PUT /job/:id
 * Updates an existing job
 */
router.post('/edit_job', upload.none(), async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ status: false, message: 'Job ID is required' });

        const payload = normalizeJobPayload(req.body);
        if (payload.title && (payload.title.length < 3 || payload.title.length > 200)) {
            return res.status(400).json({
                status: false,
                message: 'Job title must be between 3 and 200 characters in length.',
            });
        }

        const [result] = await pool.query(
            `UPDATE jobs SET 
                title=?, company_name=?, category=?, location=?, job_type=?, salary=?, 
                experience_required=?, posted_at=?, apply_by=?, status=?, vacancies_count=?, 
                description=?, requirements=? 
             WHERE id=?`,
            [
                payload.title,
                payload.company_name,
                payload.category,
                payload.location,
                payload.job_type,
                payload.salary,
                payload.experience_required,
                payload.posted_at,
                payload.apply_by,
                payload.status,
                payload.vacancies_count,
                payload.description,
                payload.requirements,
                id,
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: false, message: 'Job not found' });
        }

        const [rows] = await pool.query("SELECT * FROM jobs WHERE id = ?", [id]);
        res.status(200).json({ status: true, message: 'Job Updated Successfully', job: rows[0] });
    } catch (error) {
        console.error("Error updating job:", error);
        res.status(500).json({ status: false, message: 'Server error' });
    }
});

/**
 * POST /job/delete_job or DELETE /job/:id
 */
router.post('/delete_job', async (req, res) => {
    try {
        const { id } = req.body;
        const [result] = await pool.query("DELETE FROM jobs WHERE id=?", [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: false, message: 'Job not found' });
        }

        res.status(200).json({ status: true, message: 'Job Deleted Successfully' });
    } catch (error) {
        console.error("Error deleting job:", error);
        res.status(500).json({ status: false, message: 'Server error' });
    }
});

router.get("/fetch_all_apply_user", async (req, res) => {
    try {
        const [applications] = await pool.query(
            `SELECT 
                a.*,
                j.title as job_title,
                j.company_name,
                j.location as job_location,
                j.salary as job_salary
             FROM applications a
             JOIN jobs j ON a.job_id = j.id
             ORDER BY a.applied_at DESC`
        );
        res.status(200).json({ status: true, data: applications });
    } catch (error) {
        console.error("Error fetching applications:", error);
        res.status(500).json({ status: false, message: "Internal Server Error" });
    }
});

module.exports = router;
