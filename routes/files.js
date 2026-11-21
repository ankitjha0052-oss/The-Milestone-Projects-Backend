const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('./pool');
const authMiddleware = require('./authMiddleware');
const router = express.Router();
const DIRS = [path.join(__dirname, '../private/resumes'), path.join(__dirname, '../public/resumes')];

// GET /files/resume/:filename -> Only accessible by admin/superadmin, the candidate who owns it, or the employer who posted the job
router.get('/resume/:filename', authMiddleware, async (req, res, next) => {
  try {
    const name = path.basename(req.params.filename);
    let allowed = ['admin', 'superadmin'].includes(req.user.role);
    if (!allowed) {
      const [rows] = await pool.query(
        `SELECT 1 FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
         WHERE a.resume_path = ? AND (a.user_id = ? OR a.email = ? OR j.user_id = ?) LIMIT 1`,
        [name, req.user.id, req.user.email, req.user.id]
      );
      allowed = rows.length > 0;
      if (!allowed) {
        const [p] = await pool.query(
          'SELECT 1 FROM candidate_profiles WHERE user_id = ? AND resume_path = ? LIMIT 1',
          [req.user.id, name]
        );
        allowed = p.length > 0;
      }
    }
    if (!allowed) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
    const file = DIRS.map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
    if (!file) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resume file not found.' } });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    res.sendFile(file);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
