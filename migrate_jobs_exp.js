// Database migration for job experience ranges (exp_min_months, exp_max_months) and status index
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

async function runJobExperienceMigration() {
  console.log('🚀 Running Job Experience migration...');
  try {
    await addColumnIfNotExists('jobs', 'exp_min_months', 'INT NULL');
    await addColumnIfNotExists('jobs', 'exp_max_months', 'INT NULL');

    // Backfill existing jobs based on experience_required
    const fill = [
      ['Fresher%', 0, 12],
      ['1-3%', 12, 36],
      ['3-5%', 36, 60],
      ['5-8%', 60, 96],
    ];

    for (const [like, min, max] of fill) {
      const [res] = await pool.query(
        "UPDATE jobs SET exp_min_months = ?, exp_max_months = ? WHERE exp_min_months IS NULL AND experience_required LIKE ?",
        [min, max, like]
      );
      if (res.affectedRows > 0) {
        console.log(`Updated ${res.affectedRows} jobs for pattern '${like}' -> [${min}, ${max}]`);
      }
    }

    const [res8] = await pool.query(
      "UPDATE jobs SET exp_min_months = 96 WHERE exp_min_months IS NULL AND experience_required LIKE '8+%'"
    );
    if (res8.affectedRows > 0) {
      console.log(`Updated ${res8.affectedRows} jobs for pattern '8+%' -> min 96`);
    }

    try {
      await pool.query("ALTER TABLE jobs ADD INDEX idx_jobs_status_created (status, created_at)");
      console.log("✅ Added index idx_jobs_status_created");
    } catch (e) {
      if (e.errno === 1061) {
        console.log("ℹ️ Index idx_jobs_status_created already exists (skipped)");
      } else {
        console.warn("Note on index:", e.message);
      }
    }

    console.log('🎉 Job experience migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runJobExperienceMigration();
}

module.exports = { runJobExperienceMigration };
