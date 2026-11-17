const pool = require('./routes/pool'); // Correct import

const createJobsTableQuery = `
CREATE TABLE IF NOT EXISTS jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    salary DECIMAL(10, 2),
    posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    apply_by DATE,
    status ENUM('active', 'closed') DEFAULT 'active',
    job_type ENUM('full-time', 'part-time', 'contract', 'internship') DEFAULT 'full-time',
    category VARCHAR(100)
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
const createUsersTableQuery = `
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    number VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

(async () => {
    try {
        await pool.query(createJobsTableQuery);
        console.log('✅ Table "jobs" created successfully!');

        await pool.query(createApplicationsTableQuery);
        console.log('✅ Table "applications" created successfully!');
        await pool.query(createUsersTableQuery);
        console.log('✅ Table "user" created successfully!')
    } catch (err) {
        console.error('❌ Error creating tables:', err);
    } finally {
        await pool.end();
        console.log('🔒 Connection closed successfully.');
    }
})();
