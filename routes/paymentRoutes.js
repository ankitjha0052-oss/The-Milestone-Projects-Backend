const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const cron = require("node-cron");
const pool = require("./pool");
const authMiddleware = require("./authMiddleware");

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

if (process.env.NODE_ENV === "production") {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !RAZORPAY_WEBHOOK_SECRET) {
    throw new Error("FATAL: Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET) missing in production!");
  }
}

const rzp = new Razorpay({
  key_id: RAZORPAY_KEY_ID || "rzp_test_placeholder",
  key_secret: RAZORPAY_KEY_SECRET || "rzp_secret_placeholder",
});

function httpError(status, code, message) {
  const e = new Error(message);
  e.statusCode = status;
  e.code = code;
  return e;
}

function sendError(res, err, next) {
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
  }
  next(err);
}

// ---------------------------------------------------------------------
// Payment success hone ke baad plan activate karna.
// IDEMPOTENT: verify API aur webhook dono call karein to bhi ek hi subscription banegi.
// ---------------------------------------------------------------------
async function activateOrder(razorpayOrderId, razorpayPaymentId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [orders] = await conn.query("SELECT * FROM orders WHERE razorpay_order_id = ? FOR UPDATE", [razorpayOrderId]);
    if (orders.length === 0) throw httpError(404, "ORDER_NOT_FOUND", "Order could not be found.");
    const order = orders[0];

    if (order.status === "PAID") {
      await conn.commit();
      return { alreadyActivated: true };
    }

    const [plans] = await conn.query("SELECT * FROM plans WHERE id = ?", [order.plan_id]);
    const plan = plans[0];

    // Pehle se active plan hai to naya uske end se shuru hoga (stack)
    const [t] = await conn.query(
      `SELECT NOW() AS now_ts,
              (SELECT MAX(ends_at) FROM subscriptions WHERE user_id = ? AND status = 'ACTIVE' AND ends_at > NOW()) AS last_end`,
      [order.user_id]
    );
    const startsNow = !t[0].last_end;
    const startsAt = new Date(t[0].last_end || t[0].now_ts);
    const endsAt = new Date(startsAt.getTime() + plan.duration_days * 24 * 60 * 60 * 1000);

    const subId = crypto.randomUUID();
    await conn.query(
      "INSERT INTO subscriptions (id, user_id, plan_id, order_id, starts_at, ends_at, job_limit, jobs_used, status) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'ACTIVE')",
      [subId, order.user_id, plan.id, order.id, startsAt, endsAt, plan.job_limit]
    );

    await conn.query(
      "UPDATE orders SET status = 'PAID', razorpay_payment_id = ?, paid_at = NOW() WHERE id = ?",
      [razorpayPaymentId, order.id]
    );

    // Plan abhi se chalu hai to user ki pending free jobs bhi live kar do
    if (startsNow) {
      const [pending] = await conn.query(
        "SELECT id FROM jobs WHERE user_id = ? AND status = 'PENDING_APPROVAL' ORDER BY created_at ASC LIMIT ?",
        [order.user_id, plan.job_limit]
      );
      if (pending.length > 0) {
        const ids = pending.map((j) => j.id);
        await conn.query(
          "UPDATE jobs SET status = 'ACTIVE', subscription_id = ?, approved_at = NOW(), expires_at = ? WHERE id IN (?)",
          [subId, endsAt, ids]
        );
        await conn.query("UPDATE subscriptions SET jobs_used = ? WHERE id = ?", [ids.length, subId]);
      }
    }

    await conn.commit();
    return { alreadyActivated: false, subscriptionId: subId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

const paymentRouter = express.Router();

// GET /payments/plans -> 3 cards (public)
paymentRouter.get("/plans", async (_req, res, next) => {
  try {
    const [plans] = await pool.query(
      "SELECT id, name, price_paise, job_limit, duration_days FROM plans WHERE is_active = TRUE ORDER BY price_paise ASC"
    );
    res.json({ data: plans });
  } catch (err) {
    next(err);
  }
});

// POST /payments/create-order  body: { planId }
paymentRouter.post("/create-order", authMiddleware, async (req, res, next) => {
  try {
    const planId = parseInt(req.body.planId, 10);
    const [plans] = await pool.query("SELECT * FROM plans WHERE id = ? AND is_active = TRUE", [planId]);
    if (plans.length === 0) throw httpError(404, "PLAN_NOT_FOUND", "The requested plan could not be found.");
    const plan = plans[0]; // Price from DB

    const orderId = crypto.randomUUID();
    const rzpOrder = await rzp.orders.create({
      amount: plan.price_paise,
      currency: "INR",
      receipt: orderId.slice(0, 36),
      notes: { userId: req.user.id, planId: String(plan.id) },
    });

    await pool.query(
      "INSERT INTO orders (id, user_id, plan_id, razorpay_order_id, amount_paise, status) VALUES (?, ?, ?, ?, ?, 'CREATED')",
      [orderId, req.user.id, plan.id, rzpOrder.id, plan.price_paise]
    );

    res.json({
      orderId: rzpOrder.id,
      amount: plan.price_paise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      planName: plan.name,
    });
  } catch (err) {
    sendError(res, err, next);
  }
});

// POST /payments/verify  body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
paymentRouter.post("/verify", authMiddleware, async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw httpError(400, "BAD_REQUEST", "Payment details missing");
    }

    // order must belong to user
    const [orders] = await pool.query(
      "SELECT id FROM orders WHERE razorpay_order_id = ? AND user_id = ?",
      [razorpay_order_id, req.user.id]
    );
    if (orders.length === 0) throw httpError(404, "ORDER_NOT_FOUND", "Order could not be found.");

    if (!RAZORPAY_KEY_SECRET) {
      throw httpError(500, "CONFIGURATION_ERROR", "Payment gateway secret not configured on server");
    }

    const expected = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw httpError(400, "INVALID_SIGNATURE", "Payment verification failed. Invalid signature.");
    }

    await activateOrder(razorpay_order_id, razorpay_payment_id);
    res.json({ success: true, message: "Subscription plan activated successfully." });
  } catch (err) {
    sendError(res, err, next);
  }
});

// GET /payments/subscription/me -> dashboard ke liye
paymentRouter.get("/subscription/me", authMiddleware, async (req, res, next) => {
  try {
    const [subs] = await pool.query(
      `SELECT s.id, p.name AS plan_name, s.starts_at, s.ends_at, s.job_limit, s.jobs_used
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = ? AND s.status = 'ACTIVE' AND s.ends_at > NOW()
       ORDER BY s.starts_at ASC LIMIT 1`,
      [req.user.id]
    );
    const [u] = await pool.query(
      "SELECT free_jobs_used, DATE_ADD(created_at, INTERVAL 30 DAY) AS free_ends_at, (created_at + INTERVAL 30 DAY) > NOW() AS in_free_window FROM users WHERE id = ?",
      [req.user.id]
    );

    const userRow = u[0] || { free_jobs_used: 0, in_free_window: 1 };
    res.json({
      subscription: subs[0] || null,
      free: {
        used: userRow.free_jobs_used || 0,
        limit: 5,
        endsAt: userRow.free_ends_at || null,
        active: Boolean(userRow.in_free_window),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// WEBHOOK (backup): user payment ke baad browser band kar de tab bhi plan activate ho
// ---------------------------------------------------------------------
async function webhookHandler(req, res) {
  try {
    const signature = req.headers["x-razorpay-signature"];
    if (!RAZORPAY_WEBHOOK_SECRET) {
      console.error("FATAL: RAZORPAY_WEBHOOK_SECRET is not configured on server");
      return res.status(500).send("Webhook secret unconfigured");
    }

    const expected = crypto
      .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
      .update(req.body) // raw Buffer
      .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature || ""));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString("utf8"));

    if (event.event === "payment.captured" || event.event === "order.paid") {
      const payment = event.payload.payment.entity;
      await activateOrder(payment.order_id, payment.id);
    } else if (event.event === "payment.failed") {
      const payment = event.payload.payment.entity;
      await pool.query("UPDATE orders SET status = 'FAILED' WHERE razorpay_order_id = ? AND status = 'CREATED'", [payment.order_id]);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).send("error");
  }
}

// ---------------------------------------------------------------------
// CRON: har ghante automatic expiry
// ---------------------------------------------------------------------
function startCronJobs() {
  cron.schedule("0 * * * *", async () => {
    try {
      const [j] = await pool.query("UPDATE jobs SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at < NOW()");
      const [s] = await pool.query("UPDATE subscriptions SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND ends_at < NOW()");
      // purane refresh tokens ki safai
      await pool.query("DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL 7 DAY");
      console.log(`[cron] expired jobs: ${j.affectedRows}, subscriptions: ${s.affectedRows}`);
    } catch (err) {
      console.error("[cron] error:", err.message);
    }
  });
}

module.exports = { paymentRouter, webhookHandler, startCronJobs };
