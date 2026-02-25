'use strict';

const crypto = require('crypto');
const { pool } = require('../db');

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/**
 * Hash a raw API key using SHA-256.
 * @param {string} rawKey
 * @returns {string} 64-character lowercase hex
 */
function hashKey(rawKey) {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate a new raw API key.
 * Format: "airvibe_" + 32 random bytes encoded as 64 hex characters.
 * @returns {string}
 */
function generateRawKey() {
    return 'airvibe_' + crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/**
 * Create a new API key, store its SHA-256 hash in the DB, and return the raw
 * key exactly once (it is never retrievable again after this call).
 *
 * @param {string} label  Human-readable name for the key (e.g. "ci-bot")
 * @returns {{ id: string, label: string, created_at: string, key: string }}
 */
async function createKey(label) {
    const rawKey = generateRawKey();
    const keyHash = hashKey(rawKey);

    const result = await pool.query(
        `INSERT INTO api_keys (key_hash, label)
         VALUES ($1, $2)
         RETURNING id, label, created_at`,
        [keyHash, label],
    );

    const { id, label: returnedLabel, created_at } = result.rows[0];
    return { id, label: returnedLabel, created_at, key: rawKey };
}

/**
 * Insert a known raw key idempotently (e.g. from BOOTSTRAP_API_KEY env var).
 * Uses ON CONFLICT DO NOTHING so calling this multiple times on the same key
 * is safe — repeated startup will not fail or create duplicates.
 *
 * @param {string} rawKey
 * @param {string} label
 */
async function bootstrapKey(rawKey, label) {
    const keyHash = hashKey(rawKey);
    await pool.query(
        `INSERT INTO api_keys (key_hash, label)
         VALUES ($1, $2)
         ON CONFLICT (key_hash) DO NOTHING`,
        [keyHash, label],
    );
}

/**
 * Validate a raw key against the database.
 * On success, fire-and-forgets a last_used_at timestamp update.
 *
 * @param {string} rawKey
 * @returns {object|null}  The key record (id, label, created_at, last_used_at), or null if not found.
 */
async function validateKey(rawKey) {
    const keyHash = hashKey(rawKey);

    const result = await pool.query(
        `SELECT id, label, created_at, last_used_at
         FROM api_keys
         WHERE key_hash = $1`,
        [keyHash],
    );

    if (result.rows.length === 0) return null;

    const record = result.rows[0];

    // Fire-and-forget — do not await so the request is not blocked by this write.
    pool.query(
        `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
        [record.id],
    ).catch(err => console.error('Failed to update last_used_at:', err));

    return record;
}

/**
 * List all API keys without exposing key_hash.
 * @returns {Array<{ id, label, created_at, last_used_at }>}
 */
async function listKeys() {
    const result = await pool.query(
        `SELECT id, label, created_at, last_used_at
         FROM api_keys
         ORDER BY created_at ASC`,
    );
    return result.rows;
}

/**
 * Revoke (permanently delete) an API key by its UUID.
 * @param {string} id
 * @returns {boolean}  true if the key existed and was deleted; false if not found.
 */
async function revokeKey(id) {
    const result = await pool.query(
        `DELETE FROM api_keys WHERE id = $1`,
        [id],
    );
    return result.rowCount === 1;
}

module.exports = { hashKey, generateRawKey, createKey, bootstrapKey, validateKey, listKeys, revokeKey };
