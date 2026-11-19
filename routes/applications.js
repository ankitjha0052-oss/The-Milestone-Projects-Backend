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

    const [jobRows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [job_id]);
    if (jobRows.length === 0) {
      if (req.file.path) fs.unlinkSync(req.file.path);
      return res.status(404).json({ 
        status: false, 
        message: 'Job not found' 
      });
    }

    const jobDetails = jobRows[0];
    const resumePath = req.file.filename;

    const [result] = await pool.query(
      `INSERT INTO applications 
      (job_id, full_name, email, phone, resume_path, cover_letter) 
      VALUES (?, ?, ?, ?, ?, ?)`,
      [job_id, full_name, email, phone, resumePath, cover_letter] 
    );

    // Sync candidate applicant into users table so they appear in Admin candidates list
    try {
      const [existingUser] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
      if (existingUser.length === 0) {
        const candidateId = crypto.randomUUID();
        await pool.query(
          "INSERT INTO users (id, name, email, phone, user_type, is_active) VALUES (?, ?, ?, ?, 'candidate', TRUE)",
          [candidateId, full_name, email, phone || null]
        );
      } else if (phone) {
        await pool.query("UPDATE users SET phone = COALESCE(phone, ?) WHERE email = ?", [phone, email]);
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

router.get('/job/:job_id', async (req, res) => {
  try {
    const { job_id } = req.params;
    
    const [applications] = await pool.query(
      `SELECT a.*, j.title as job_title 
       FROM applications a
       JOIN jobs j ON a.job_id = j.id
       WHERE a.job_id = ?`,
      [job_id]
    );

    res.status(200).json({ 
      status: true, 
      data: applications 
    });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Server error' 
    });
  }
});

router.put('/:id/status', async (req, res) => {
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

    const [result] = await pool.query(
      `UPDATE applications SET status = ? WHERE id = ?`,
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        status: false, 
        message: 'Application not found' 
      });
    }

    res.status(200).json({ 
      status: true, 
      message: 'Status updated successfully' 
    });
  } catch (error) {
    console.error('Error updating application status:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Server error' 
    });
  }
});

router.get('/user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    const [applications] = await pool.query(
      `SELECT a.*, j.title as job_title, j.company_name 
       FROM applications a
       JOIN jobs j ON a.job_id = j.id
       WHERE a.email = ?`,
      [email]
    );

    res.status(200).json({ 
      status: true, 
      data: applications 
    });
  } catch (error) {
    console.error('Error fetching user applications:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Server error' 
    });
  }
});

module.exports = router;