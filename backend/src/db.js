const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const log = require('./logger').child({ module: 'db' });

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
        log.info('Database initialized successfully');
    } catch (err) {
        log.error({ err }, 'Error initializing database');
    }
};

// Wait for DB to be ready (simple retry logic)
const connectWithRetry = async (retries = 5, delay = 5000) => {
    for (let i = 0; i < retries; i++) {
        try {
            await pool.query('SELECT NOW()');
            log.info('Connected to Postgres');
            await initDb();
            return;
        } catch (err) {
            log.info(`Failed to connect to Postgres (attempt ${i + 1}/${retries}): ${err.message}`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
    log.error('Could not connect to Postgres after multiple attempts');
};

module.exports = {
    pool,
    connectWithRetry
};
