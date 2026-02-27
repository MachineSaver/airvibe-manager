const { pool } = require('../db');
const log = require('../logger').child({ module: 'AuditLogger' });

class AuditLogger {
    async log(source, action, deviceEui = null, details = {}) {
        try {
            await pool.query(
                `INSERT INTO audit_log (source, action, device_eui, details) VALUES ($1, $2, $3, $4)`,
                [source, action, deviceEui, JSON.stringify(details)]
            );
        } catch (err) {
            log.error(`AuditLogger error: ${err.message}`);
        }
    }
}

module.exports = new AuditLogger();
