const pool = require('./routes/pool');

const createUsersTableQuery = `
CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255),
    given_name VARCHAR(100),
    family_name VARCHAR(100),
    email VARCHAR(255) UNIQUE,
    email_verified BOOLEAN DEFAULT FALSE,
    picture TEXT,
    locale VARCHAR(50),
    phone VARCHAR(50),
    phone_verified BOOLEAN DEFAULT FALSE,
    birthday VARCHAR(50),
    gender VARCHAR(20),
    country VARCHAR(100),
    timezone VARCHAR(100),
    profile_completed BOOLEAN DEFAULT FALSE,
    password VARCHAR(255),
    number VARCHAR(255),
    last_login_at TIMESTAMP NULL,
    login_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
`;

const createAuthIdentitiesTableQuery = `
CREATE TABLE IF NOT EXISTS auth_identities (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    provider ENUM('google', 'apple') NOT NULL,
    provider_user_id VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    is_private_email BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_provider_user (provider, provider_user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

const createRefreshTokensTableQuery = `
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    token_hash VARCHAR(128) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,
    revoked_at TIMESTAMP NULL,
    replaced_by VARCHAR(128),
    device_info VARCHAR(255),
    ip VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

const createItemsTableQuery = `
CREATE TABLE IF NOT EXISTS items (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

const createJobsTableQuery = `
CREATE TABLE IF NOT EXISTS jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    category VARCHAR(150),
    location VARCHAR(255) NOT NULL,
    job_type VARCHAR(100) DEFAULT 'Full-time Permanent',
    salary VARCHAR(100),
    experience_required VARCHAR(100),
    posted_at DATE,
    apply_by DATE,
    status VARCHAR(50) DEFAULT 'Active',
    vacancies_count INT DEFAULT 1,
    description TEXT NOT NULL,
    requirements TEXT,
    applicants_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
`;

const createApplicationsTableQuery = `
CREATE TABLE IF NOT EXISTS applications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_id INT NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    resume_path VARCHAR(255) NOT NULL,
    cover_letter TEXT,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
`;

const createSuperAdminTableQuery = `
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
);
`;

// Helper to add missing column safely if table already exists
async function addColumnIfNotExists(table, column, definition) {
    try {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`Added column ${column} to ${table}`);
    } catch (err) {
        if (err.errno !== 1060) {
            console.warn(`Note on adding column ${column}:`, err.message);
        }
    }
}

// Helper to modify column safely
async function modifyColumnSafely(table, column, definition) {
    try {
        await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
        console.log(`Modified column ${column} on ${table}`);
    } catch (err) {
        console.warn(`Note on modifying column ${column}:`, err.message);
    }
}

(async () => {
    try {
        await pool.query(createUsersTableQuery);
        console.log('✅ Table "users" checked/created!');

        // Ensure newly required columns exist on users
        await addColumnIfNotExists("users", "given_name", "VARCHAR(100)");
        await addColumnIfNotExists("users", "family_name", "VARCHAR(100)");
        await addColumnIfNotExists("users", "phone_verified", "BOOLEAN DEFAULT FALSE");
        await addColumnIfNotExists("users", "gender", "VARCHAR(20)");
        await addColumnIfNotExists("users", "country", "VARCHAR(100)");
        await addColumnIfNotExists("users", "timezone", "VARCHAR(100)");
        await addColumnIfNotExists("users", "location", "VARCHAR(255)");
        await addColumnIfNotExists("users", "headline", "VARCHAR(255)");
        await addColumnIfNotExists("users", "bio", "TEXT");
        await modifyColumnSafely("users", "picture", "MEDIUMTEXT NULL");
        await addColumnIfNotExists("users", "profile_completed", "BOOLEAN DEFAULT FALSE");
        await addColumnIfNotExists("users", "last_login_at", "TIMESTAMP NULL");
        await addColumnIfNotExists("users", "login_count", "INT DEFAULT 0");

        await pool.query(createAuthIdentitiesTableQuery);
        console.log('✅ Table "auth_identities" checked/created!');

        await pool.query(createRefreshTokensTableQuery);
        console.log('✅ Table "refresh_tokens" checked/created!');
        await addColumnIfNotExists("refresh_tokens", "revoked_at", "TIMESTAMP NULL");

        await pool.query(createItemsTableQuery);
        console.log('✅ Table "items" checked/created!');

        await pool.query(createJobsTableQuery);
        console.log('✅ Table "jobs" checked/created!');

        // Upgrade columns on jobs to match frontend form fields
        await modifyColumnSafely("jobs", "salary", "VARCHAR(100)");
        await modifyColumnSafely("jobs", "job_type", "VARCHAR(100) DEFAULT 'Full-time Permanent'");
        await modifyColumnSafely("jobs", "status", "VARCHAR(50) DEFAULT 'Active'");
        await modifyColumnSafely("jobs", "posted_at", "DATE");
        await addColumnIfNotExists("jobs", "experience_required", "VARCHAR(100)");
        await addColumnIfNotExists("jobs", "vacancies_count", "INT DEFAULT 1");
        await addColumnIfNotExists("jobs", "requirements", "TEXT");
        await addColumnIfNotExists("jobs", "applicants_count", "INT DEFAULT 0");
        await addColumnIfNotExists("jobs", "created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
        await addColumnIfNotExists("jobs", "updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

        await pool.query(createApplicationsTableQuery);
        console.log('✅ Table "applications" checked/created!');

        await pool.query(createSuperAdminTableQuery);
        console.log('✅ Table "superadmin" checked/created!');
    } catch (err) {
        console.error('❌ Error creating/updating tables:', err);
    } finally {
        await pool.end();
        console.log('🔒 Database connection closed.');
    }
})();
