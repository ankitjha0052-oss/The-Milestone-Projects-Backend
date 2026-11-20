const pool = require('./routes/pool');

async function syncFreeJobs() {
  try {
    console.log('--- Starting Free Jobs Quota Synchronization ---');

    // 1. Find all users and their actual free jobs count
    const [rows] = await pool.query(`
      SELECT 
        u.id, 
        u.email, 
        u.free_jobs_used AS recorded_free_used,
        COUNT(j.id) AS actual_free_jobs
      FROM users u
      LEFT JOIN jobs j ON j.user_id = u.id AND (j.subscription_id IS NULL OR j.subscription_id = '')
      GROUP BY u.id, u.email, u.free_jobs_used
    `);

    console.log(`Found ${rows.length} users to inspect:`);
    for (const r of rows) {
      const maxCount = Math.max(Number(r.recorded_free_used) || 0, Number(r.actual_free_jobs) || 0);
      console.log(`User: ${r.email} (${r.id}) -> recorded: ${r.recorded_free_used}, actual jobs: ${r.actual_free_jobs}, synced to: ${maxCount}`);

      if (r.recorded_free_used !== maxCount) {
        await pool.query('UPDATE users SET free_jobs_used = ? WHERE id = ?', [maxCount, r.id]);
        console.log(`  -> Updated user ${r.email} free_jobs_used to ${maxCount}`);
      }
    }

    console.log('--- Free Jobs Quota Synchronization Completed Successfully ---');
    process.exit(0);
  } catch (err) {
    console.error('Error during synchronization:', err);
    process.exit(1);
  }
}

syncFreeJobs();
