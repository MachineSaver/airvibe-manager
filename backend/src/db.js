const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    user: process.env.POSTGRES_USER || 'postgres',
    host: process.env.POSTGRES_HOST || 'postgres', // Docker service name
    database: process.env.POSTGRES_DB || 'airvibe',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    port: process.env.POSTGRES_PORT || 5432,
});

// Initialize DB
const initDb = async () => {
    try {
        const schemaPath = path.join(__dirname, 'db', 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        await pool.query(schemaSql);
        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Error initializing database:', err);
    }
};

// Wait for DB to be ready (simple retry logic)
const connectWithRetry = async (retries = 5, delay = 5000) => {
    for (let i = 0; i < retries; i++) {
        try {
            await pool.query('SELECT NOW()');
            console.log('Connected to Postgres');
            await initDb();
            return;
        } catch (err) {
            console.log(`Failed to connect to Postgres (attempt ${i + 1}/${retries}):`, err.message);
            await new Promise(res => setTimeout(res, delay));
        }
    }
    console.error('Could not connect to Postgres after multiple attempts');
};

module.exports = {
    pool,
    connectWithRetry
};
