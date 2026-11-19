const pool = require('./routes/pool');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

async function createAndSeedSuperadmin() {
    try {
        console.log("Creating table 'superadmin' if not exists...");
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
        console.log("✅ Table 'superadmin' created successfully!");

        const email = 'info@themilestoneprojects.co.in';
        const password = 'themilestoneprojects123@';
        const hash = bcrypt.hashSync(password, 12);

        // 1. Insert/Update in superadmin table
        const [existingSuper] = await pool.query('SELECT id FROM superadmin WHERE email = ?', [email]);
        let adminId;
        if (existingSuper.length > 0) {
            adminId = existingSuper[0].id;
            await pool.query(
                "UPDATE superadmin SET password_hash = ?, is_active = TRUE, role = 'superadmin', login_id = ? WHERE id = ?",
                [hash, email, adminId]
            );
            console.log("✅ Updated password in superadmin table for:", email);
        } else {
            adminId = crypto.randomUUID();
            await pool.query(
                `INSERT INTO superadmin (id, name, email, login_id, password_hash, role, is_active)
                 VALUES (?, 'Super Admin', ?, ?, ?, 'superadmin', TRUE)`,
                [adminId, email, email, hash]
            );
            console.log("✅ Inserted new superadmin into superadmin table:", email);
        }

        // 2. Ensure superadmin is NOT in users table (clean separation)
        await pool.query("DELETE FROM users WHERE email = ? OR role = 'superadmin'", [email]);
        console.log("✅ Ensured 'users' table has NO admin entries (clean separation maintained).");

        console.log("\n--- superadmin table records ---");
        const [superadmins] = await pool.query("SELECT id, name, email, login_id, role, is_active, created_at FROM superadmin");
        console.table(superadmins);

        process.exit(0);
    } catch (err) {
        console.error("❌ Error creating/seeding superadmin table:", err);
        process.exit(1);
    }
}

createAndSeedSuperadmin();
