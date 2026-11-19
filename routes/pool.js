require('dotenv').config();
const mysql = require('mysql2'); 

if (!process.env.DB_PASSWORD) {
    throw new Error("FATAL: DB_PASSWORD environment variable is missing!");
}

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'milestone_projects_db',
    multipleStatements: false,
    connectionLimit: 99
}).promise(); 
module.exports = pool;
