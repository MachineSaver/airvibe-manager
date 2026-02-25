'use strict';

const apiKeyManager = require('../services/ApiKeyManager');

// Paths that are always accessible without an API key.
const EXEMPT_PATHS = new Set(['/', '/api/health']);

/**
 * Express middleware: enforce Bearer API key authentication.
 *
 * Behaviour:
 *   - No-op (calls next()) when API_KEYS_ENABLED !== "true".
 *   - No-op for paths in EXEMPT_PATHS ('/' and '/api/health').
 *   - Returns 401 if the Authorization header is missing or not Bearer format.
 *   - Returns 401 if the key does not exist in the database.
 *   - Attaches the key record to req.apiKey and calls next() on success.
 *
 * Works identically in both ChirpStack and ThingPark deployment modes —
 * authentication is network-server-agnostic.
 */
async function requireApiKey(req, res, next) {
    if (process.env.API_KEYS_ENABLED !== 'true') return next();
    if (EXEMPT_PATHS.has(req.path)) return next();

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Missing or invalid Authorization header. Use: Authorization: Bearer <api-key>',
        });
    }

    const rawKey = authHeader.slice(7); // strip 'Bearer '

    let record;
    try {
        record = await apiKeyManager.validateKey(rawKey);
    } catch (err) {
        console.error('Auth: key validation failed:', err);
        return res.status(503).json({ error: 'Authentication service temporarily unavailable.' });
    }

    if (!record) {
        return res.status(401).json({ error: 'Invalid API key.' });
    }

    req.apiKey = record;
    return next();
}

module.exports = { requireApiKey };
