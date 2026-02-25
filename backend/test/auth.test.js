'use strict';

// ---------------------------------------------------------------------------
// Mock all external dependencies BEFORE any require() calls.
// ---------------------------------------------------------------------------

jest.mock('../src/db', () => ({
    pool: { query: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { pool } = require('../src/db');
const apiKeyManager = require('../src/services/ApiKeyManager');
const { requireApiKey } = require('../src/middleware/auth');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    jest.clearAllMocks();
    // Provide a safe default so fire-and-forget calls (e.g. last_used_at UPDATE)
    // don't blow up when no mockResolvedValueOnce is registered for them.
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.API_KEYS_ENABLED;
});

// ---------------------------------------------------------------------------
// hashKey
// ---------------------------------------------------------------------------

describe('ApiKeyManager.hashKey', () => {
    it('returns a 64-character lowercase hex string (SHA-256)', () => {
        const hash = apiKeyManager.hashKey('any-input');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same input', () => {
        expect(apiKeyManager.hashKey('same')).toBe(apiKeyManager.hashKey('same'));
    });

    it('produces different output for different inputs', () => {
        expect(apiKeyManager.hashKey('a')).not.toBe(apiKeyManager.hashKey('b'));
    });
});

// ---------------------------------------------------------------------------
// generateRawKey
// ---------------------------------------------------------------------------

describe('ApiKeyManager.generateRawKey', () => {
    it('starts with the "airvibe_" prefix', () => {
        expect(apiKeyManager.generateRawKey()).toMatch(/^airvibe_/);
    });

    it('appends 64 hex characters after the prefix', () => {
        // 32 random bytes encoded as hex = 64 chars
        expect(apiKeyManager.generateRawKey()).toMatch(/^airvibe_[0-9a-f]{64}$/);
    });

    it('generates unique keys', () => {
        expect(apiKeyManager.generateRawKey()).not.toBe(apiKeyManager.generateRawKey());
    });
});

// ---------------------------------------------------------------------------
// createKey
// ---------------------------------------------------------------------------

describe('ApiKeyManager.createKey', () => {
    it('returns id, label, created_at, and the raw key', async () => {
        const createdAt = new Date().toISOString();
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 'uuid-1', label: 'ci-bot', created_at: createdAt }],
        });

        const result = await apiKeyManager.createKey('ci-bot');

        expect(result.id).toBe('uuid-1');
        expect(result.label).toBe('ci-bot');
        expect(result.created_at).toBe(createdAt);
        expect(result.key).toMatch(/^airvibe_[0-9a-f]{64}$/);
    });

    it('stores the SHA-256 hash of the key, not the raw key', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 'uuid-1', label: 'test', created_at: new Date().toISOString() }],
        });

        const result = await apiKeyManager.createKey('test');
        const [sql, params] = pool.query.mock.calls[0];

        expect(sql).toMatch(/INSERT INTO api_keys/i);
        // Raw key must NOT appear in the query params
        expect(params).not.toContain(result.key);
        // The stored value must be a 64-char hex hash
        expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not include key_hash in the returned object', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 'uuid-1', label: 'test', created_at: new Date().toISOString() }],
        });

        const result = await apiKeyManager.createKey('test');

        expect(result).not.toHaveProperty('key_hash');
    });
});

// ---------------------------------------------------------------------------
// bootstrapKey
// ---------------------------------------------------------------------------

describe('ApiKeyManager.bootstrapKey', () => {
    it('inserts a key with ON CONFLICT DO NOTHING (idempotent)', async () => {
        await apiKeyManager.bootstrapKey('airvibe_testkey', 'bootstrap');

        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO api_keys/i);
        expect(sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
        expect(params[1]).toBe('bootstrap');
    });

    it('hashes the raw key before storing', async () => {
        const rawKey = 'airvibe_mybootstrapkey';
        await apiKeyManager.bootstrapKey(rawKey, 'label');

        const [, params] = pool.query.mock.calls[0];
        expect(params[0]).not.toBe(rawKey);
        expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not throw if the key already exists', async () => {
        // ON CONFLICT DO NOTHING means rowCount = 0 — not an error
        pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await expect(apiKeyManager.bootstrapKey('airvibe_dup', 'dup')).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// validateKey
// ---------------------------------------------------------------------------

describe('ApiKeyManager.validateKey', () => {
    it('returns the key record when the key exists', async () => {
        const record = { id: 'key-id', label: 'my-app', created_at: new Date().toISOString(), last_used_at: null };
        pool.query.mockResolvedValueOnce({ rows: [record] }); // SELECT

        const result = await apiKeyManager.validateKey('airvibe_valid');

        expect(result).toEqual(record);
        expect(pool.query.mock.calls[0][0]).toMatch(/SELECT.*FROM api_keys.*WHERE key_hash/is);
    });

    it('queries by SHA-256 hash of the provided raw key', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });
        const rawKey = 'airvibe_testkey123';

        await apiKeyManager.validateKey(rawKey);

        const [, params] = pool.query.mock.calls[0];
        expect(params[0]).toBe(apiKeyManager.hashKey(rawKey)); // hash, not raw
        expect(params[0]).not.toBe(rawKey);
    });

    it('returns null when the key does not exist', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const result = await apiKeyManager.validateKey('airvibe_badkey');

        expect(result).toBeNull();
    });

    it('fire-and-forgets a last_used_at update on success', async () => {
        pool.query.mockResolvedValueOnce({ rows: [{ id: 'key-id', label: 'test' }] }); // SELECT

        await apiKeyManager.validateKey('airvibe_validkey');

        // Second call should be the UPDATE (fire-and-forget)
        const updateCall = pool.query.mock.calls[1];
        expect(updateCall[0]).toMatch(/UPDATE api_keys SET last_used_at/i);
        expect(updateCall[1]).toContain('key-id');
    });
});

// ---------------------------------------------------------------------------
// listKeys
// ---------------------------------------------------------------------------

describe('ApiKeyManager.listKeys', () => {
    it('returns an array of key metadata rows', async () => {
        const rows = [
            { id: 'uuid-1', label: 'app-a', created_at: new Date().toISOString(), last_used_at: null },
            { id: 'uuid-2', label: 'app-b', created_at: new Date().toISOString(), last_used_at: null },
        ];
        pool.query.mockResolvedValueOnce({ rows });

        const result = await apiKeyManager.listKeys();

        expect(result).toHaveLength(2);
    });

    it('does not expose key_hash in any row', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 'uuid-1', label: 'app', created_at: new Date().toISOString(), last_used_at: null }],
        });

        const [key] = await apiKeyManager.listKeys();

        expect(key).not.toHaveProperty('key_hash');
        expect(key).toHaveProperty('id');
        expect(key).toHaveProperty('label');
    });

    it('selects id, label, created_at, last_used_at — not key_hash', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        await apiKeyManager.listKeys();

        const [sql] = pool.query.mock.calls[0];
        expect(sql).not.toMatch(/key_hash/i);
    });
});

// ---------------------------------------------------------------------------
// revokeKey
// ---------------------------------------------------------------------------

describe('ApiKeyManager.revokeKey', () => {
    it('returns true when the key was deleted', async () => {
        pool.query.mockResolvedValueOnce({ rowCount: 1 });

        const result = await apiKeyManager.revokeKey('uuid-1');

        expect(result).toBe(true);
        expect(pool.query.mock.calls[0][0]).toMatch(/DELETE FROM api_keys/i);
        expect(pool.query.mock.calls[0][1]).toContain('uuid-1');
    });

    it('returns false when the key ID does not exist', async () => {
        pool.query.mockResolvedValueOnce({ rowCount: 0 });

        const result = await apiKeyManager.revokeKey('nonexistent-uuid');

        expect(result).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// requireApiKey middleware
// ---------------------------------------------------------------------------

describe('requireApiKey middleware', () => {
    let req, res, next;

    beforeEach(() => {
        req = { headers: {}, path: '/api/waveforms' };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        next = jest.fn();
    });

    it('is a no-op when API_KEYS_ENABLED is not set', async () => {
        delete process.env.API_KEYS_ENABLED;
        await requireApiKey(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    it('is a no-op when API_KEYS_ENABLED is "false"', async () => {
        process.env.API_KEYS_ENABLED = 'false';
        await requireApiKey(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('bypasses auth for the root path', async () => {
        process.env.API_KEYS_ENABLED = 'true';
        req.path = '/';
        await requireApiKey(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('bypasses auth for /api/health', async () => {
        process.env.API_KEYS_ENABLED = 'true';
        req.path = '/api/health';
        await requireApiKey(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('returns 401 when auth is enabled and no Authorization header is present', async () => {
        process.env.API_KEYS_ENABLED = 'true';
        await requireApiKey(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when the header is not Bearer format', async () => {
        process.env.API_KEYS_ENABLED = 'true';
        req.headers['authorization'] = 'Basic dXNlcjpwYXNz';
        await requireApiKey(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when the key is not found in the database', async () => {
        process.env.API_KEYS_ENABLED = 'true';
        req.headers['authorization'] = 'Bearer airvibe_unknownkey';
        pool.query.mockResolvedValueOnce({ rows: [] }); // SELECT → not found

        await requireApiKey(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next() and attaches req.apiKey when the key is valid', async () => {
        process.env.API_KEYS_ENABLED = 'true';
        req.headers['authorization'] = 'Bearer airvibe_validkey123';
        pool.query.mockResolvedValueOnce({ rows: [{ id: 'key-id', label: 'test-app' }] });

        await requireApiKey(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.apiKey).toEqual({ id: 'key-id', label: 'test-app' });
        expect(res.status).not.toHaveBeenCalled();
    });
});
