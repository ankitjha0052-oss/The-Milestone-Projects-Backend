-- ============ users table updates ============
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role ENUM('user','admin','superadmin') NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS free_jobs_used INT NOT NULL DEFAULT 0;

-- ============ plans ============
CREATE TABLE IF NOT EXISTS plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  price_paise INT NOT NULL,          -- Rs 1000 = 100000
  job_limit INT NOT NULL,
  duration_days INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO plans (name, price_paise, job_limit, duration_days) 
SELECT 'Starter', 100000, 10, 30 FROM DUAL WHERE NOT EXISTS (SELECT id FROM plans WHERE id = 1)
UNION ALL
SELECT 'Growth', 300000, 30, 180 FROM DUAL WHERE NOT EXISTS (SELECT id FROM plans WHERE id = 2)
UNION ALL
SELECT 'Pro', 500000, 50, 365 FROM DUAL WHERE NOT EXISTS (SELECT id FROM plans WHERE id = 3);

-- ============ orders ============
CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  plan_id INT NOT NULL,
  razorpay_order_id VARCHAR(64) NOT NULL UNIQUE,
  razorpay_payment_id VARCHAR(64) NULL UNIQUE,
  amount_paise INT NOT NULL,
  status ENUM('CREATED','PAID','FAILED') NOT NULL DEFAULT 'CREATED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
);

-- ============ subscriptions ============
CREATE TABLE IF NOT EXISTS subscriptions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  plan_id INT NOT NULL,
  order_id CHAR(36) NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  job_limit INT NOT NULL,
  jobs_used INT NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_status (user_id, status, ends_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- ============ admin_logs ============
CREATE TABLE IF NOT EXISTS admin_logs (
  id CHAR(36) PRIMARY KEY,
  admin_id CHAR(36) NOT NULL,
  action VARCHAR(50) NOT NULL,
  job_id CHAR(36) NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
