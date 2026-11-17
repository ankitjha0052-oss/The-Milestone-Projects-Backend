const express = require('express');
const router = express.Router();
const pool = require('./pool');
const multer = require('multer');

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "public/images");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + "-" + file.originalname);
    },
});
const upload = multer({ storage: storage });


router.post('/add_job', upload.single('file'), async (req, res) => {
    try {
        console.log(req.body);
        console.log(req.file); 

        const { title, description, company_name, location, salary, posted_at, apply_by, status, job_type, category } = req.body;

        const [result] = await pool.query(
            "INSERT INTO jobs (title, description, company_name, location, salary, posted_at, apply_by, status, job_type, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [title, description, company_name, location, salary, posted_at, apply_by, status, job_type, category]
        );

        res.status(200).json({ status: true, message: 'Job Added Successfully', job_id: result.insertId });
    } catch (error) {
        console.error("Error adding job:", error);
        res.status(500).json({ status: false, message: 'Server error' });
    }
});


router.get("/fetch_all_jobs", async (req, res) => {
    try {
        const [jobs] = await pool.query("SELECT * FROM jobs");
        res.status(200).json({ status: true, data: jobs });
    } catch (error) {
        console.error("Error fetching jobs:", error);
        res.status(500).json({ status: false, message: "Internal Server Error" });
    }
});


router.post('/edit_job', async (req, res) => {
    try {
        const { id, title, description, company_name, location, salary, posted_at, apply_by, status, job_type, category } = req.body;

        const [result] = await pool.query(
            "UPDATE jobs SET title=?, description=?, company_name=?, location=?, salary=?, posted_at=?, apply_by=?, status=?, job_type=?, category=? WHERE id=?",
            [title, description, company_name, location, salary, posted_at, apply_by, status, job_type, category, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: false, message: 'Job not found' });
        }

        res.status(200).json({ status: true, message: 'Job Updated Successfully' });
    } catch (error) {
        console.error("Error updating job:", error);
        res.status(500).json({ status: false, message: 'Server error' });
    }
});


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

router.post('/add_contact', upload.single('file'), async (req, res) => {
    try {
        console.log(req.body);
        console.log(req.file); 

        const { f_Name, l_Name,email, phone, message } = req.body;

        const [result] = await pool.query(
            "INSERT INTO users (f_name, l_name, email, number, message) VALUES (?, ?, ?, ?, ?)",
            [f_Name, l_Name, email, phone, message]
        );

        res.status(200).json({ status: true, message: 'Successfully'});
    } catch (error) {
        console.error("Error adding job:", error);
        res.status(500).json({ status: false, message: 'Server error' });
    }
});

router.get("/fetch_all_contact", async (req, res) => {
    try {
        const [users] = await pool.query("SELECT * FROM users");
        res.status(200).json({ status: true, data: users });
    } catch (error) {
        console.error("Error fetching jobs:", error);
        res.status(500).json({ status: false, message: "Internal Server Error" });
    }
});

module.exports = router;
