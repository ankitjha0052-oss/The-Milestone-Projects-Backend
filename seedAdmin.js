const bcrypt = require('bcryptjs');
const pool = require('./routes/pool');
const crypto = require('crypto');

async function seedSuperAdmin() {
    try {
        const hash = bcrypt.hashSync('themilestoneprojects123@', 12);
        const email = 'info@themilestoneprojects.co.in';

        // 1. Clean superadmin table
        const [existing] = await pool.query(
            "SELECT id, email, role, login_id FROM superadmin WHERE login_id = ? OR email = ?",
            [email, email]
        );

        if (existing.length > 0) {
            await pool.query(
                "UPDATE superadmin SET role = 'superadmin', login_id = ?, password_hash = ?, is_active = TRUE WHERE id = ?",
                [email, hash, existing[0].id]
            );
            console.log("✅ Updated superadmin in 'superadmin' table:", email);
        } else {
            const id = crypto.randomUUID();
            await pool.query(
                `INSERT INTO superadmin (id, name, email, login_id, password_hash, role, is_active)
                 VALUES (?, 'Super Admin', ?, ?, ?, 'superadmin', TRUE)`,
                [id, email, email, hash]
            );
            console.log("✅ Created fresh superadmin in 'superadmin' table:", email);
        }

        // 2. Remove any admin from users table
        await pool.query("DELETE FROM users WHERE email = ? OR role = 'superadmin'", [email]);
        console.log("✅ Cleaned any admin records from 'users' table.");

        const [adminRows] = await pool.query("SELECT id, name, email, role, login_id, is_active FROM superadmin WHERE email = ?", [email]);
        console.table(adminRows);
        process.exit(0);
    } catch (e) {
        console.error("Superadmin seed error:", e);
        process.exit(1);
    }
}

seedSuperAdmin();
