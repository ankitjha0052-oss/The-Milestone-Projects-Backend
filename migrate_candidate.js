// Database migration for Candidate profile, experience, education, and applications status
const pool = require('./routes/pool');

async function addColumnIfNotExists(table, column, definition) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✅ Added column "${column}" to table "${table}"`);
  } catch (err) {
    if (err.errno === 1060) {
      console.log(`ℹ️ Column "${column}" already exists in table "${table}" (skipped)`);
    } else {
      console.warn(`⚠️ Warning adding column "${column}" to "${table}":`, err.message);
    }
  }
}

async function runCandidateMigration() {
  console.log('🚀 Running Candidate module migration...');

  try {
    // 1. candidate_profiles table
    const createCandidateProfilesTable = `
      CREATE TABLE IF NOT EXISTS candidate_profiles (
        user_id CHAR(36) PRIMARY KEY,
        headline VARCHAR(255) NULL,
        summary TEXT NULL,
        total_exp_months INT NULL,
        current_ctc INT NULL,
        expected_ctc INT NULL,
        notice_period_days INT NULL,
        current_city VARCHAR(100) NULL,
        resume_path VARCHAR(255) NULL,
        skills JSON NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_candidate_profiles_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `;
    await pool.query(createCandidateProfilesTable);
    console.log('✅ Table "candidate_profiles" created/verified!');

    // 2. candidate_experience table
    const createCandidateExperienceTable = `
      CREATE TABLE IF NOT EXISTS candidate_experience (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        company VARCHAR(150) NOT NULL,
        designation VARCHAR(150) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NULL,
        is_current BOOLEAN DEFAULT FALSE,
        description TEXT NULL,
        INDEX idx_candidate_exp_user (user_id),
        CONSTRAINT fk_candidate_exp_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `;
    await pool.query(createCandidateExperienceTable);
    console.log('✅ Table "candidate_experience" created/verified!');

    // 3. candidate_education table
    const createCandidateEducationTable = `
      CREATE TABLE IF NOT EXISTS candidate_education (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        degree VARCHAR(150) NOT NULL,
        institute VARCHAR(150) NOT NULL,
        year_of_passing INT NOT NULL,
        INDEX idx_candidate_edu_user (user_id),
        CONSTRAINT fk_candidate_edu_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `;
    await pool.query(createCandidateEducationTable);
    console.log('✅ Table "candidate_education" created/verified!');

    // 4. applications table: status column check/add
    await addColumnIfNotExists(
      'applications',
      'status',
      "ENUM('pending', 'reviewed', 'accepted', 'rejected') DEFAULT 'pending'"
    );

    console.log('🎉 Candidate migration completed successfully!');
  } catch (err) {
    console.error('❌ Candidate migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runCandidateMigration();
}

module.exports = { runCandidateMigration };
