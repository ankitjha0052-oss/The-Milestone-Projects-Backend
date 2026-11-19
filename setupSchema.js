const pool = require('./routes/pool');

async function runSchema() {
    try {
        console.log("Checking and updating database schema with Admin columns...");

        // 1. Add role & free_jobs_used to users
        try {
            await pool.query("ALTER TABLE users ADD COLUMN role ENUM('user','admin','superadmin') NOT NULL DEFAULT 'user'");
            console.log("Added column role to users");
        } catch (e) {
            if (e.errno !== 1060) console.warn("users role notice:", e.message);
        }

        try {
            await pool.query("ALTER TABLE users ADD COLUMN free_jobs_used INT NOT NULL DEFAULT 0");
            console.log("Added column free_jobs_used to users");
        } catch (e) {
            if (e.errno !== 1060) console.warn("users free_jobs_used notice:", e.message);
        }

        // Add admin auth columns: login_id, password_hash, is_active, user_type
        const userAdminCols = [
            { name: "login_id", def: "VARCHAR(50) NULL UNIQUE" },
            { name: "password_hash", def: "VARCHAR(100) NULL" },
            { name: "is_active", def: "BOOLEAN NOT NULL DEFAULT TRUE" },
            { name: "user_type", def: "ENUM('candidate','employer') NOT NULL DEFAULT 'candidate'" }
        ];

        for (const col of userAdminCols) {
            try {
                await pool.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`);
                console.log(`Added column ${col.name} to users`);
            } catch (e) {
                if (e.errno !== 1060) console.warn(`users ${col.name} notice:`, e.message);
            }
        }

        // 2. Plans table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS plans (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(50) NOT NULL,
                price_paise INT NOT NULL,
                job_limit INT NOT NULL,
                duration_days INT NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT TRUE
            )
        `);
        console.log("✅ Table plans ready");

        // Seed 3 plans
        await pool.query(`
            INSERT INTO plans (id, name, price_paise, job_limit, duration_days) 
            VALUES 
                (1, 'Starter', 100000, 10, 30),
                (2, 'Growth',  300000, 30, 180),
                (3, 'Pro',     500000, 50, 365)
            ON DUPLICATE KEY UPDATE name=VALUES(name), price_paise=VALUES(price_paise), job_limit=VALUES(job_limit), duration_days=VALUES(duration_days)
        `);
        console.log("✅ Default plans seeded (Starter, Growth, Pro)");

        // 3. Orders table
        await pool.query(`
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
            )
        `);
        console.log("✅ Table orders ready");

        // 4. Subscriptions table
        await pool.query(`
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
            )
        `);
        console.log("✅ Table subscriptions ready");

        // 5. Admin Logs table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_logs (
                id CHAR(36) PRIMARY KEY,
                admin_id CHAR(36) NOT NULL,
                action VARCHAR(50) NOT NULL,
                job_id CHAR(36) NULL,
                note VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("✅ Table admin_logs ready");

        // 6. Update jobs table with user_id, subscription_id, and approval fields
        const jobColumns = [
            { name: "user_id", def: "CHAR(36) NULL" },
            { name: "subscription_id", def: "CHAR(36) NULL" },
            { name: "approved_by", def: "CHAR(36) NULL" },
            { name: "approved_at", def: "DATETIME NULL" },
            { name: "expires_at", def: "DATETIME NULL" },
            { name: "rejection_reason", def: "VARCHAR(255) NULL" }
        ];

        for (const col of jobColumns) {
            try {
                await pool.query(`ALTER TABLE jobs ADD COLUMN ${col.name} ${col.def}`);
                console.log(`Added column ${col.name} to jobs`);
            } catch (e) {
                if (e.errno !== 1060) console.warn(`jobs ${col.name} note:`, e.message);
            }
        }

        try {
            await pool.query("ALTER TABLE jobs MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'PENDING_APPROVAL'");
        } catch (e) {
            console.warn("jobs status note:", e.message);
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS superadmin (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(100) DEFAULT 'Super Admin',
                email VARCHAR(191) NOT NULL UNIQUE,
                login_id VARCHAR(100) NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL DEFAULT 'superadmin',
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log("✅ Table superadmin ready");

        console.log("🎉 All tables and schema updates applied successfully!");
        process.exit(0);
    } catch (err) {
        console.error("❌ Schema update failed:", err);
        process.exit(1);
    }
}

runSchema();
