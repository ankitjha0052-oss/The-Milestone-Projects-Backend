// Candidate routes: Profile, Experience, Education, Applications, and Resume management
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const pool = require('./pool');
const authMiddleware = require('./authMiddleware');
const {
  calculateProfileCompletion,
  syncUserProfileCompleted,
} = require('../utils/profileCompletion');

// Ensure private resumes directory exists
const privateResumesDir = path.join(__dirname, '../private/resumes');
if (!fs.existsSync(privateResumesDir)) {
  fs.mkdirSync(privateResumesDir, { recursive: true });
}

// Multer storage for private candidate resumes
const resumeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, privateResumesDir);
  },
  filename: (req, file, cb) => {
    const randomHex = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `resume-${randomHex}-${Date.now()}${ext}`);
  },
});

const resumeUpload = multer({
  storage: resumeStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    // Fix 1: Strict extension AND mime check (no application/octet-stream bypass)
    const ext = path.extname(file.originalname).toLowerCase();
    const okExt = ['.pdf', '.doc', '.docx'].includes(ext);
    const okMime = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ].includes(file.mimetype);

    if (okExt && okMime) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, and DOCX files are allowed (max 5MB).'));
    }
  },
});

// All candidate routes require authentication & role === 'user'
router.use(authMiddleware);

router.use((req, res, next) => {
  if (req.user?.role !== 'user') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Candidate user access only.' },
    });
  }
  next();
});

// Helper: load candidate full profile data for completion check
async function getCandidateData(userId) {
  const [users] = await pool.query(
    'SELECT id, name, email, phone, picture FROM users WHERE id = ?',
    [userId]
  );
  const user = users[0] || null;

  const [profiles] = await pool.query(
    `SELECT headline, summary, total_exp_months, current_ctc, expected_ctc,
            notice_period_days, current_city, resume_path, skills, updated_at
     FROM candidate_profiles WHERE user_id = ?`,
    [userId]
  );
  const profile = profiles[0] || null;

  // Ensure skills is parsed array
  if (profile && typeof profile.skills === 'string') {
    try {
      profile.skills = JSON.parse(profile.skills);
    } catch (_) {
      profile.skills = [];
    }
  }

  // Fix 2: DATE_FORMAT prevents timezone shift in ISO output (e.g. 2023-04-30T18:30:00Z)
  const [experience] = await pool.query(
    `SELECT id, company, designation,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
            is_current, description
     FROM candidate_experience WHERE user_id = ?
     ORDER BY is_current DESC, start_date DESC`,
    [userId]
  );

  const [education] = await pool.query(
    `SELECT id, degree, institute, year_of_passing
     FROM candidate_education WHERE user_id = ?
     ORDER BY year_of_passing DESC`,
    [userId]
  );

  const completion = calculateProfileCompletion({
    user,
    profile,
    experience,
    education,
  });

  return { user, profile, experience, education, completion };
}

// ---------------------------------------------------------------------
// 1. GET /candidate/profile
// ---------------------------------------------------------------------
router.get('/profile', async (req, res, next) => {
  try {
    const data = await getCandidateData(req.user.id);
    await syncUserProfileCompleted(pool, req.user.id, data.completion.percent);

    res.json({
      user: data.user,
      profile: data.profile,
      experience: data.experience,
      education: data.education,
      completion: data.completion,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// 2. PUT /candidate/profile
// ---------------------------------------------------------------------
router.put('/profile', async (req, res, next) => {
  try {
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
    const {
      name,
      phone,
      headline,
      summary,
      total_exp_months,
      current_ctc,
      expected_ctc,
      notice_period_days,
      current_city,
      skills,
    } = req.body;

    // Validation: name
    if (has('name')) {
      if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 255) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Full name must be between 1 and 255 characters.' },
        });
      }
    }

    // Validation: phone (allows clearing if empty/null, validates if provided)
    if (has('phone') && phone !== null && String(phone).trim() !== '') {
      const phoneRegex = /^\+?[0-9\s\-()]{7,25}$/;
      if (!phoneRegex.test(String(phone).trim())) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Invalid phone number format.' },
        });
      }
    }

    // Validation: headline
    if (has('headline') && headline !== null && String(headline).trim().length > 255) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Headline cannot exceed 255 characters.' },
      });
    }

    // Validation: summary
    if (has('summary') && summary !== null && String(summary).trim().length > 2000) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Summary cannot exceed 2000 characters.' },
      });
    }

    // Validation: current_city
    if (has('current_city') && current_city !== null && String(current_city).trim().length > 100) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Current city cannot exceed 100 characters.' },
      });
    }

    // Validation: numeric values with strict upper boundaries (prevent SQL out-of-range)
    const validateIntegerRange = (val, fieldName, min, max) => {
      if (val === undefined || val === null || val === '') return null;
      const num = Number(val);
      if (!Number.isInteger(num) || num < min || num > max) {
        throw new Error(`${fieldName} must be an integer between ${min} and ${max}.`);
      }
      return num;
    };

    let totalExp, ctc, expCtc, noticeDays;
    try {
      totalExp = validateIntegerRange(total_exp_months, 'Total experience (months)', 0, 720); // max 60 yrs
      noticeDays = validateIntegerRange(notice_period_days, 'Notice period (days)', 0, 365); // max 1 yr
      ctc = validateIntegerRange(current_ctc, 'Current CTC', 0, 1000000000); // max 100 Cr
      expCtc = validateIntegerRange(expected_ctc, 'Expected CTC', 0, 1000000000); // max 100 Cr
    } catch (valErr) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: valErr.message },
      });
    }

    // Validation: skills (max 30 items x 50 chars, trim & dedupe)
    let processedSkills = null;
    if (has('skills')) {
      if (skills !== null) {
        if (!Array.isArray(skills)) {
          return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'Skills must be an array of strings.' },
          });
        }
        const seen = new Set();
        const cleaned = [];
        for (const item of skills) {
          if (typeof item === 'string') {
            const t = item.trim();
            if (t.length > 0 && t.length <= 50 && !seen.has(t.toLowerCase())) {
              seen.add(t.toLowerCase());
              cleaned.push(t);
              if (cleaned.length >= 30) break;
            }
          }
        }
        processedSkills = JSON.stringify(cleaned);
      } else {
        processedSkills = JSON.stringify([]);
      }
    }

    // Fix 3: Selective update for users table (allows clearing phone when requested)
    const userUpdates = [];
    const userVals = [];
    if (has('name')) {
      userUpdates.push('name = ?');
      userVals.push(name.trim());
    }
    if (has('phone')) {
      userUpdates.push('phone = ?');
      userVals.push(phone && String(phone).trim() ? String(phone).trim() : null);
    }
    if (userUpdates.length > 0) {
      userVals.push(req.user.id);
      await pool.query(`UPDATE users SET ${userUpdates.join(', ')} WHERE id = ?`, userVals);
    }

    // Fix 3: Fetch current profile values and pick updated vs existing without COALESCE
    const curData = await getCandidateData(req.user.id);
    const cur = curData.profile || {};
    const pick = (k, v) => (has(k) ? v : (cur[k] ?? null));

    const upsertProfileSql = `
      INSERT INTO candidate_profiles (
        user_id, headline, summary, total_exp_months, current_ctc, expected_ctc,
        notice_period_days, current_city, skills
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        headline = VALUES(headline),
        summary = VALUES(summary),
        total_exp_months = VALUES(total_exp_months),
        current_ctc = VALUES(current_ctc),
        expected_ctc = VALUES(expected_ctc),
        notice_period_days = VALUES(notice_period_days),
        current_city = VALUES(current_city),
        skills = VALUES(skills);
    `;

    await pool.query(upsertProfileSql, [
      req.user.id,
      pick('headline', headline && String(headline).trim() ? String(headline).trim() : null),
      pick('summary', summary && String(summary).trim() ? String(summary).trim() : null),
      pick('total_exp_months', totalExp),
      pick('current_ctc', ctc),
      pick('expected_ctc', expCtc),
      pick('notice_period_days', noticeDays),
      pick('current_city', current_city && String(current_city).trim() ? String(current_city).trim() : null),
      pick('skills', has('skills') ? processedSkills : (cur.skills ? JSON.stringify(cur.skills) : null)),
    ]);

    const updatedData = await getCandidateData(req.user.id);
    await syncUserProfileCompleted(pool, req.user.id, updatedData.completion.percent);

    res.json({
      success: true,
      message: 'Candidate profile updated successfully.',
      user: updatedData.user,
      profile: updatedData.profile,
      completion: updatedData.completion,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// 3. POST /candidate/resume
// ---------------------------------------------------------------------
router.post('/resume', (req, res, next) => {
  resumeUpload.single('resume')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'File size too large. Maximum allowed size is 5MB.'
        : uploadErr.message;
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: msg },
      });
    }

    try {
      if (!req.file) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Resume file is required.' },
        });
      }

      // Check existing resume filename
      const [existingProfiles] = await pool.query(
        'SELECT resume_path FROM candidate_profiles WHERE user_id = ?',
        [req.user.id]
      );
      const oldResumeFilename = existingProfiles[0]?.resume_path;
      const newFilename = req.file.filename;

      // Fix 4: Upsert DB FIRST. If this fails, catch block removes new file and preserves old file.
      await pool.query(
        `INSERT INTO candidate_profiles (user_id, resume_path)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE resume_path = VALUES(resume_path)`,
        [req.user.id, newFilename]
      );

      // Fix 4: Delete old resume file ONLY AFTER DB upsert succeeds
      if (oldResumeFilename && oldResumeFilename !== newFilename) {
        const safeOld = path.basename(oldResumeFilename);
        const oldPrivate = path.join(privateResumesDir, safeOld);
        if (fs.existsSync(oldPrivate)) {
          try { fs.unlinkSync(oldPrivate); } catch (_) {}
        }
        const oldPublic = path.join(__dirname, '../public/resumes', safeOld);
        if (fs.existsSync(oldPublic)) {
          try { fs.unlinkSync(oldPublic); } catch (_) {}
        }
      }

      const data = await getCandidateData(req.user.id);
      await syncUserProfileCompleted(pool, req.user.id, data.completion.percent);

      res.json({
        success: true,
        message: 'Resume uploaded successfully.',
        resume_path: newFilename,
        completion: data.completion,
      });
    } catch (err) {
      // If DB upsert failed, clean up newly uploaded file
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      next(err);
    }
  });
});

// ---------------------------------------------------------------------
// 4. Experience: POST, PUT, DELETE
// ---------------------------------------------------------------------
function isValidIsoDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const dt = new Date(d);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

function validateExperienceBody(body) {
  const company = String(body.company || '').trim();
  const designation = String(body.designation || '').trim();
  const startDate = String(body.start_date || '').trim();
  const isCurrent = body.is_current === true || body.is_current === 'true' || body.is_current === 1 || body.is_current === '1';
  const endDate = body.end_date ? String(body.end_date).trim() : null;
  const description = body.description ? String(body.description).trim() : null;

  if (!company || company.length > 150) {
    throw new Error('Company name is required (max 150 characters).');
  }
  if (!designation || designation.length > 150) {
    throw new Error('Designation is required (max 150 characters).');
  }

  if (!isValidIsoDate(startDate)) {
    throw new Error('Valid start date (YYYY-MM-DD) is required.');
  }

  if (!isCurrent) {
    if (!endDate || !isValidIsoDate(endDate)) {
      throw new Error('Valid end date (YYYY-MM-DD) is required when is_current is false.');
    }
    if (new Date(endDate) < new Date(startDate)) {
      throw new Error('End date must be greater than or equal to start date.');
    }
  }

  if (description && description.length > 1000) {
    throw new Error('Job description cannot exceed 1000 characters.');
  }

  return {
    company,
    designation,
    start_date: startDate,
    end_date: isCurrent ? null : endDate,
    is_current: isCurrent,
    description,
  };
}

router.post('/experience', async (req, res, next) => {
  try {
    let validated;
    try {
      validated = validateExperienceBody(req.body);
    } catch (e) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    }

    const [result] = await pool.query(
      `INSERT INTO candidate_experience
       (user_id, company, designation, start_date, end_date, is_current, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        validated.company,
        validated.designation,
        validated.start_date,
        validated.end_date,
        validated.is_current,
        validated.description,
      ]
    );

    const data = await getCandidateData(req.user.id);
    await syncUserProfileCompleted(pool, req.user.id, data.completion.percent);

    res.status(201).json({
      success: true,
      message: 'Experience record added successfully.',
      id: result.insertId,
      completion: data.completion,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/experience/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Valid experience ID required.' } });
    }

    let validated;
    try {
      validated = validateExperienceBody(req.body);
    } catch (e) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    }

    const [result] = await pool.query(
      `UPDATE candidate_experience SET
         company = ?, designation = ?, start_date = ?, end_date = ?, is_current = ?, description = ?
       WHERE id = ? AND user_id = ?`,
      [
        validated.company,
        validated.designation,
        validated.start_date,
        validated.end_date,
        validated.is_current,
        validated.description,
        id,
        req.user.id,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Experience record not found.' },
      });
    }

    const data = await getCandidateData(req.user.id);
    await syncUserProfileCompleted(pool, req.user.id, data.completion.percent);

    res.json({
      success: true,
      message: 'Experience record updated successfully.',
      completion: data.completion,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/experience/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Valid experience ID required.' } });
    }

    const [result] = await pool.query(
      'DELETE FROM candidate_experience WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Experience record not found.' },
      });
    }

    const data = await getCandidateData(req.user.id);
    await syncUserProfileCompleted(pool, req.user.id, data.completion.percent);

    res.json({
      success: true,
      message: 'Experience record deleted successfully.',
      completion: data.completion,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// 5. Education: POST, PUT, DELETE
// ---------------------------------------------------------------------
function validateEducationBody(body) {
  const degree = String(body.degree || '').trim();
  const institute = String(body.institute || '').trim();
  const year = parseInt(body.year_of_passing, 10);
  const currentYear = new Date().getFullYear();

  if (!degree || degree.length > 150) {
    throw new Error('Degree is required (max 150 characters).');
  }
  if (!institute || institute.length > 150) {
    throw new Error('Institute name is required (max 150 characters).');
  }
  if (!year || isNaN(year) || year < 1950 || year > currentYear + 6) {
    throw new Error(`Year of passing must be between 1950 and ${currentYear + 6}.`);
  }

  return {
    degree,
    institute,
    year_of_passing: year,
  };
}

router.post('/education', async (req, res, next) => {
  try {
    let validated;
    try {
      validated = validateEducationBody(req.body);
    } catch (e) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    }

    const [result] = await pool.query(
      `INSERT INTO candidate_education (user_id, degree, institute, year_of_passing)
       VALUES (?, ?, ?, ?)`,
      [req.user.id, validated.degree, validated.institute, validated.year_of_passing]
    );

    const data = await getCandidateData(req.user.id);
    await syncUserProfileCompleted(pool, req.user.id, data.completion.percent);

    res.status(201).json({
      success: true,
      message: 'Education record added successfully.',
      id: result.insertId,
      completion: data.completion,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/education/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Valid education ID required.' } });
    }

    let validated;
    try {
      validated = validateEducationBody(req.body);
    } catch (e) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    }

    const [result] = await pool.query(
      `UPDATE candidate_education SET degree = ?, institute = ?, year_of_passing = ?
       WHERE id = ? AND user_id = ?`,
      [validated.degree, validated.institute, validated.year_of_passing, id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Education record not found.' },
      });
    }

    const data = await getCandidateData(req.user.id);
    await syncUserProfileCompleted(pool, req.user.id, data.completion.percent);

    res.json({
      success: true,
      message: 'Education record updated successfully.',
      completion: data.completion,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/education/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Valid education ID required.' } });
    }

    const [result] = await pool.query(
      'DELETE FROM candidate_education WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Education record not found.' },
      });
    }

    const data = await getCandidateData(req.user.id);
    await syncUserProfileCompleted(pool, req.user.id, data.completion.percent);

    res.json({
      success: true,
      message: 'Education record deleted successfully.',
      completion: data.completion,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// 6. GET /candidate/applications
// Returns applications submitted by this candidate's user_id or email (with snapshot & job_closed)
// ---------------------------------------------------------------------
router.get('/applications', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.job_id, a.status, DATE_FORMAT(a.applied_at,'%Y-%m-%d %H:%i') AS applied_at,
              COALESCE(j.title, a.job_title) AS job_title, COALESCE(j.company_name, a.company_name) AS company_name,
              j.location AS job_location, j.job_type, j.salary,
              (j.id IS NULL OR j.status <> 'ACTIVE') AS job_closed
       FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
       WHERE a.user_id = ? OR a.email = ? ORDER BY a.applied_at DESC`,
      [req.user.id, req.user.email]
    );

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// 7. POST /candidate/apply
// Authenticated 1-click apply using candidate's profile data and uploaded resume
// ---------------------------------------------------------------------
const LIVE = "status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > NOW())";

router.post('/apply', async (req, res, next) => {
  try {
    const jobId = parseInt(req.body.job_id, 10);
    const cover = String(req.body.cover_letter || '').trim().slice(0, 1000) || null;
    if (!jobId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'job_id is required.' } });

    const [jobs] = await pool.query(`SELECT id, title, company_name FROM jobs WHERE id = ? AND ${LIVE}`, [jobId]);
    if (!jobs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This job is no longer accepting applications.' } });

    const [dup] = await pool.query('SELECT id FROM applications WHERE job_id = ? AND (user_id = ? OR email = ?) LIMIT 1', [jobId, req.user.id, req.user.email]);
    if (dup.length) return res.status(409).json({ error: { code: 'ALREADY_APPLIED', message: 'You have already applied for this job.' } });

    const { user, profile } = await getCandidateData(req.user.id);
    if (!user?.name || !user?.phone)
      return res.status(400).json({ error: { code: 'PROFILE_INCOMPLETE', message: 'Add your name and phone in profile before applying.' } });
    const src = profile?.resume_path ? path.join(privateResumesDir, path.basename(profile.resume_path)) : null;
    if (!src || !fs.existsSync(src))
      return res.status(400).json({ error: { code: 'RESUME_REQUIRED', message: 'Upload your resume in profile before applying.' } });

    // Application ki apni resume copy: profile resume replace/delete hone par bhi application na toote
    const copyName = `app-${crypto.randomBytes(16).toString('hex')}${path.extname(src)}`;
    const copyPath = path.join(privateResumesDir, copyName);
    fs.copyFileSync(src, copyPath);
    try {
      const [r] = await pool.query(
        `INSERT INTO applications (job_id, user_id, full_name, email, phone, resume_path, cover_letter, job_title, company_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jobId, req.user.id, user.name, req.user.email, user.phone, copyName, cover, jobs[0].title, jobs[0].company_name]);
      res.status(201).json({ success: true, message: 'Application submitted.', application_id: r.insertId });
    } catch (e) { try { fs.unlinkSync(copyPath); } catch (_) {} throw e; }
  } catch (err) { next(err); }
});

module.exports = router;
