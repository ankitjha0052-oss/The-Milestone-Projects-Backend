// Migration script to safe-guard applications table:
// 1. Adds job_title, company_name, user_id snapshot columns
// 2. Backfills snapshots from jobs
// 3. Modifies job_id to nullable and alters FK to ON DELETE SET NULL
// 4. Adds index on user_id

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

async function runApplicationSafeMigration() {
  console.log('🚀 Running Application Safe Migration...');
  try {
    await addColumnIfNotExists('applications', 'job_title', 'VARCHAR(255) NULL');
    await addColumnIfNotExists('applications', 'company_name', 'VARCHAR(255) NULL');
    await addColumnIfNotExists('applications', 'user_id', 'CHAR(36) NULL');

    await pool.query(`UPDATE applications a JOIN jobs j ON j.id = a.job_id
      SET a.job_title = j.title, a.company_name = j.company_name WHERE a.job_title IS NULL`);
    console.log('✅ Backfilled job_title and company_name snapshots in applications');

    const [fks] = await pool.query(`SELECT CONSTRAINT_NAME AS n FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications' AND COLUMN_NAME = 'job_id' AND REFERENCED_TABLE_NAME = 'jobs'`);
    for (const f of fks) {
      await pool.query(`ALTER TABLE applications DROP FOREIGN KEY \`${f.n}\``);
      console.log(`✅ Dropped foreign key ${f.n}`);
    }

    await pool.query('ALTER TABLE applications MODIFY job_id INT NULL');
    console.log('✅ Altered applications.job_id to INT NULL');

    await pool.query('ALTER TABLE applications ADD CONSTRAINT fk_app_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL');
    console.log('✅ Added foreign key fk_app_job ON DELETE SET NULL');

    try {
      await pool.query('ALTER TABLE applications ADD INDEX idx_app_user (user_id)');
      console.log('✅ Added index idx_app_user on applications(user_id)');
    } catch (_) {
      console.log('ℹ️ Index idx_app_user already exists or skipped');
    }

    console.log('🎉 Application safe migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

runApplicationSafeMigration();
