const mysql = require('mysql2'); 

const pool = mysql.createPool({
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'Ankit123@',
    database: 'milestone_projects_db',
    multipleStatements: true,
    connectionLimit: 99
}).promise(); 
module.exports = pool;
