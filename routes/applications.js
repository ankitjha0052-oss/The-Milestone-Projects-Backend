const express = require('express');
const router = express.Router();
const pool = require('./pool');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); 
const crypto = require('crypto');
const { sendApplicationEmail } = require('./mailer');


const uploadDir = path.join(__dirname, '../public/resumes');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /pdf|doc|docx/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, and DOCX files are allowed!'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 
  }
});

router.post('/apply', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        status: false, 
        message: 'Resume file is required' 
      });
    }

    const { job_id, full_name, email, phone, cover_letter } = req.body;

    if (!fs.existsSync(req.file.path)) {
      throw new Error('Failed to save resume file');
    }

    const [jobRows] = await pool.query(
      "SELECT * FROM jobs WHERE id = ? AND status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > NOW())",
      [job_id]
    );
    if (jobRows.length === 0) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).json({ 
        status: false, 
        message: 'This job is no longer accepting applications.' 
      });
    }

    // duplicate rokna (insert se pehle)
    const [dup] = await pool.query(
      "SELECT id FROM applications WHERE job_id = ? AND email = ? LIMIT 1",
      [job_id, email]
    );
    if (dup.length) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(409).json({ 
        status: false, 
        message: 'You have already applied for this job.' 
      });
    }

    const jobDetails = jobRows[0];
    const resumePath = req.file.filename;

    const [result] = await pool.query(
      `INSERT INTO applications 
      (job_id, full_name, email, phone, resume_path, cover_letter, job_title, company_name) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [job_id, full_name, email, phone, resumePath, cover_letter, jobDetails.title, jobDetails.company_name] 
    );

    // Sync candidate applicant into users table so they appear in Admin candidates list
    try {
      const [existingUser] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
      let candidateId;
      if (existingUser.length === 0) {
        candidateId = crypto.randomUUID();
        await pool.query(
          "INSERT INTO users (id, name, email, phone, user_type, is_active) VALUES (?, ?, ?, ?, 'candidate', TRUE)",
          [candidateId, full_name, email, phone || null]
        );
      } else {
        candidateId = existingUser[0].id;
        if (phone) {
          await pool.query("UPDATE users SET phone = COALESCE(phone, ?) WHERE email = ?", [phone, email]);
        }
      }
      if (candidateId && result.insertId) {
        await pool.query("UPDATE applications SET user_id = ? WHERE id = ?", [candidateId, result.insertId]);
      }
    } catch (syncErr) {
      console.warn("Could not sync candidate to users table:", syncErr.message);
    }
    
    try {
      await sendApplicationEmail(email, { full_name, email, phone }, jobDetails);
    } catch (emailError) {
      console.error('Error sending email:', emailError);
    }

    res.status(201).json({ 
      status: true, 
      message: 'Application submitted successfully',
      application_id: result.insertId
    });

  } catch (error) {
    console.error('Error submitting application:', error);
    
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    let errorMessage = 'Server error';
    if (error.message.includes('file type')) {
      errorMessage = 'Only PDF, DOC, and DOCX files are allowed';
    } else if (error.code === 'LIMIT_FILE_SIZE') {
      errorMessage = 'File size too large (max 5MB)';
    } else if (error.message.includes('Failed to save')) {
      errorMessage = 'Error processing your resume';
    }

    res.status(500).json({ 
      status: false, 
      message: errorMessage 
    });
  }
});

const authMiddleware = require('./authMiddleware');

// GET /applications/mine -> Recruiter / employer views applicants for their posted jobs
router.get('/mine', authMiddleware, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, COALESCE(j.title, a.job_title) AS job_title, COALESCE(j.company_name, a.company_name) AS company_name
       FROM applications a 
       LEFT JOIN jobs j ON a.job_id = j.id
       WHERE j.user_id = ? 
       ORDER BY a.applied_at DESC`,
      [req.user.id]
    );
    res.json({ status: true, data: rows });
  } catch (e) {
    next(e);
  }
});

// GET /applications/job/:job_id -> Protected: only job owner or superadmin can view applicants
router.get('/job/:job_id', authMiddleware, async (req, res, next) => {
  try {
    const { job_id } = req.params;
    
    const [jobRows] = await pool.query('SELECT user_id, title FROM jobs WHERE id = ?', [job_id]);
    if (jobRows.length === 0) {
      return res.status(404).json({ status: false, message: 'Job not found' });
    }
    const isOwner = jobRows[0].user_id === req.user.id;
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to view applicants for this job' } });
    }

    const [applications] = await pool.query(
      `SELECT a.*, COALESCE(j.title, a.job_title) as job_title, COALESCE(j.company_name, a.company_name) as company_name 
       FROM applications a
       LEFT JOIN jobs j ON a.job_id = j.id
       WHERE a.job_id = ?
       ORDER BY a.applied_at DESC`,
      [job_id]
    );

    res.status(200).json({ 
      status: true, 
      data: applications 
    });
  } catch (error) {
    next(error);
  }
});

// PUT /applications/:id/status -> Protected: only job owner or superadmin can update status
router.put('/:id/status', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'reviewed', 'accepted', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        status: false, 
        message: 'Invalid status' 
      });
    }

    const [appRows] = await pool.query(
      `SELECT a.id, j.user_id 
       FROM applications a 
       JOIN jobs j ON a.job_id = j.id 
       WHERE a.id = ?`,
      [id]
    );

    if (appRows.length === 0) {
      return res.status(404).json({ 
        status: false, 
        message: 'Application not found' 
      });
    }

    const isOwner = appRows[0].user_id === req.user.id;
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ 
        error: { code: 'FORBIDDEN', message: 'You do not have permission to update this application' } 
      });
    }

    await pool.query(
      `UPDATE applications SET status = ? WHERE id = ?`,
      [status, id]
    );

    res.status(200).json({ 
      status: true, 
      message: 'Status updated successfully' 
    });
  } catch (error) {
    next(error);
  }
});

// GET /applications/user/:email -> Protected: only owner of the email or superadmin can view
router.get('/user/:email', authMiddleware, async (req, res, next) => {
  try {
    const { email } = req.params;

    if (req.user.email !== email && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
    
    const [applications] = await pool.query(
      `SELECT a.*, COALESCE(j.title, a.job_title) as job_title, COALESCE(j.company_name, a.company_name) as company_name 
       FROM applications a
       LEFT JOIN jobs j ON a.job_id = j.id
       WHERE a.email = ?
       ORDER BY a.applied_at DESC`,
      [email]
    );

    res.status(200).json({ 
      status: true, 
      data: applications 
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;