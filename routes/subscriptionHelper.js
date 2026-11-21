const crypto = require("crypto");

const PRIORITY = { Growth: 1, Pro: 2 };

/**
 * Shared Subscription Activator
 * - Upgrade (higher price plan) -> Starts immediately NOW, marks older lower plan as EXPIRED,
 *   moves active jobs to new subscription with updated expiry and higher priority.
 * - Same or lower tier plan -> Queued to start seamlessly after the latest active subscription ends.
 */
async function startSubscription(conn, { userId, plan, orderId, jobLimit, durationDays }) {
  const limit = jobLimit || plan.job_limit;
  const days = durationDays || plan.duration_days;
  const priority = PRIORITY[plan.name] || 0;

  const [cur] = await conn.query(
    `SELECT s.id, s.starts_at, s.ends_at, p.price_paise 
     FROM subscriptions s 
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND s.status = 'ACTIVE' AND s.ends_at > NOW() 
     FOR UPDATE`,
    [userId]
  );

  const running = cur.filter((s) => new Date(s.starts_at) <= new Date());
  const topPrice = running.reduce((m, s) => Math.max(m, s.price_paise), 0);
  const upgradeNow = running.length > 0 && plan.price_paise > topPrice;
  const startsNow = running.length === 0 || upgradeNow;

  const [[t]] = await conn.query("SELECT NOW() AS now_ts");
  const nowMs = new Date(t.now_ts).getTime();
  const bonusMs = upgradeNow ? Math.max(0, ...running.map((s) => new Date(s.ends_at).getTime() - nowMs)) : 0;
  const startsAt = startsNow
    ? new Date(t.now_ts)
    : new Date(Math.max(...cur.map((s) => new Date(s.ends_at).getTime())));
  const endsAt = new Date(startsAt.getTime() + days * 86400000 + bonusMs);
  const subId = crypto.randomUUID();

  await conn.query(
    "INSERT INTO subscriptions (id, user_id, plan_id, order_id, starts_at, ends_at, job_limit, jobs_used, status) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'ACTIVE')",
    [subId, userId, plan.id, orderId, startsAt, endsAt, limit]
  );

  if (!startsNow) {
    if (running.length > 0) {
      await conn.query(
        "UPDATE jobs SET expires_at = ? WHERE user_id = ? AND status = 'ACTIVE' AND subscription_id IN (?)",
        [endsAt, userId, running.map((s) => s.id)]
      );
    }
  }

  if (startsNow) {
    let used = 0;
    if (upgradeNow) {
      const oldIds = running.map((s) => s.id);
      await conn.query("UPDATE subscriptions SET status = 'EXPIRED', ends_at = NOW() WHERE id IN (?)", [oldIds]);
      const [mv] = await conn.query(
        "UPDATE jobs SET subscription_id = ?, expires_at = ?, priority = ? WHERE subscription_id IN (?) AND status = 'ACTIVE'",
        [subId, endsAt, priority, oldIds]
      );
      used += mv.affectedRows;
    }

    const [pending] = await conn.query(
      "SELECT id FROM jobs WHERE user_id = ? AND status = 'PENDING_APPROVAL' ORDER BY created_at ASC LIMIT ?",
      [userId, Math.max(limit - used, 0)]
    );

    if (pending.length) {
      await conn.query(
        "UPDATE jobs SET status = 'ACTIVE', subscription_id = ?, priority = ?, approved_at = NOW(), expires_at = ? WHERE id IN (?)",
        [subId, priority, endsAt, pending.map((j) => j.id)]
      );
      used += pending.length;
    }

    if (used) {
      await conn.query("UPDATE subscriptions SET jobs_used = ? WHERE id = ?", [used, subId]);
    }

    if (priority > 0) {
      await conn.query("UPDATE jobs SET priority = GREATEST(priority, ?) WHERE user_id = ? AND status = 'ACTIVE'", [priority, userId]);
    }
  }

  return { subId, startsAt, endsAt, startsNow, upgradeNow };
}

module.exports = { startSubscription, PRIORITY };
