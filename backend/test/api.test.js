'use strict';

// ---------------------------------------------------------------------------
// Mock all external dependencies BEFORE requiring app.js.
// Jest hoists jest.mock() calls, so the mocks are in place when app.js loads.
// ---------------------------------------------------------------------------

jest.mock('../src/db', () => ({
    connectWithRetry: jest.fn().mockResolvedValue(),
    pool: { query: jest.fn() },
}));

jest.mock('../src/mqttClient', () => ({
    connect: jest.fn(),
    publish: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/services/FUOTAManager', () => ({
    init: jest.fn().mockResolvedValue(),
    processPacket: jest.fn(),
    getActiveSessions: jest.fn().mockReturnValue([]),
    storeFirmware: jest.fn().mockReturnValue({ sessionId: 'test', totalBlocks: 10 }),
    startSession: jest.fn().mockResolvedValue(),
    abortSession: jest.fn().mockResolvedValue(true),
    setVerifyMaxRetries: jest.fn(),
    updateBlockInterval: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/services/WaveformManager', () => ({
    processPacket: jest.fn(),
}));

jest.mock('../src/services/SpectrumProcessor', () => ({
    processWaveform: jest.fn().mockResolvedValue(undefined),
    recoverOrphanedWaveforms: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/DemoSimulator', () => ({
    start: jest.fn().mockReturnValue({ started: true }),
    stop: jest.fn().mockReturnValue({ stopped: true }),
    getStatus: jest.fn().mockReturnValue({ running: false }),
}));

jest.mock('../src/services/AuditLogger', () => ({
    log: jest.fn(),
}));

jest.mock('../src/services/networkServerClient', () => ({
    configured: false,
    type: 'chirpstack',
}));

jest.mock('../src/pki', () => ({
    generateCA: jest.fn().mockResolvedValue(),
    generateServerCert: jest.fn().mockResolvedValue(),
    generateClientCert: jest.fn().mockResolvedValue({ cert: '---', key: '---' }),
}));

jest.mock('../src/utils/deinterleave', () => ({
    deinterleaveWaveform: jest.fn().mockReturnValue({
        axis1: [1, 2, 3], axis2: [], axis3: [],
        isAxis1: true, isAxis2: false, isAxis3: false,
    }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

const request = require('supertest');
const { app } = require('../src/app');
const { pool } = require('../src/db');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEV_EUI = 'AABBCCDDEEFF0011';

const makeWaveform = (overrides = {}) => ({
    id: 'uuid-1',
    device_eui: DEV_EUI,
    transaction_id: 1,
    start_time: '2024-01-01T00:00:00.000Z',
    status: 'complete',
    expected_segments: 10,
    received_segments_count: 10,
    metadata: { sampleRate: 20000 },
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
});

const makeFuotaSession = (overrides = {}) => ({
    id: 'fuota-uuid-1',
    device_eui: DEV_EUI,
    firmware_name: 'v2.1.bin',
    firmware_size: 1024,
    total_blocks: 21,
    block_interval_ms: 3000,
    status: 'complete',
    blocks_sent: 21,
    verify_attempts: 1,
    last_missed_blocks: [],
    error: null,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:05:00.000Z',
    updated_at: '2024-01-01T00:05:00.000Z',
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    // Default fallback so fire-and-forget calls (e.g. last_used_at UPDATE from
    // ApiKeyManager.validateKey) don't crash when no mockResolvedValueOnce is set.
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.API_KEYS_ENABLED;
});

// ---------------------------------------------------------------------------
// GET /api/waveforms — filtering and pagination
// ---------------------------------------------------------------------------

describe('GET /api/waveforms', () => {
    it('returns waveforms and X-Total-Count header with no filters', async () => {
        const waveforms = [makeWaveform(), makeWaveform({ id: 'uuid-2', status: 'pending' })];
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '2' }] })  // COUNT
            .mockResolvedValueOnce({ rows: waveforms });         // DATA

        const res = await request(app).get('/api/waveforms');

        expect(res.status).toBe(200);
        expect(res.headers['x-total-count']).toBe('2');
        expect(res.body).toHaveLength(2);
    });

    it('filters by status — passes status into WHERE clause', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '1' }] })
            .mockResolvedValueOnce({ rows: [makeWaveform()] });

        const res = await request(app).get('/api/waveforms?status=complete');

        expect(res.status).toBe(200);
        expect(res.headers['x-total-count']).toBe('1');
        const [countSql, countParams] = pool.query.mock.calls[0];
        expect(countSql).toMatch(/status\s*=\s*\$/i);
        expect(countParams).toContain('complete');
    });

    it('filters by device_eui', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '1' }] })
            .mockResolvedValueOnce({ rows: [makeWaveform()] });

        const res = await request(app).get(`/api/waveforms?device_eui=${DEV_EUI}`);

        expect(res.status).toBe(200);
        const [, countParams] = pool.query.mock.calls[0];
        expect(countParams).toContain(DEV_EUI);
    });

    it('filters by from and to timestamps', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .get('/api/waveforms?from=2024-01-01T00:00:00Z&to=2024-12-31T23:59:59Z');

        expect(res.status).toBe(200);
        const [, countParams] = pool.query.mock.calls[0];
        expect(countParams).toContain('2024-01-01T00:00:00Z');
        expect(countParams).toContain('2024-12-31T23:59:59Z');
    });

    it('applies limit and offset — both appear in the data query params', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '20' }] })
            .mockResolvedValueOnce({ rows: [makeWaveform()] });

        const res = await request(app).get('/api/waveforms?limit=5&offset=10');

        expect(res.status).toBe(200);
        expect(res.headers['x-total-count']).toBe('20');
        const [dataSql, dataParams] = pool.query.mock.calls[1];
        expect(dataSql).toMatch(/LIMIT/i);
        expect(dataSql).toMatch(/OFFSET/i);
        expect(dataParams).toContain(5);
        expect(dataParams).toContain(10);
    });

    it('clamps limit to a maximum of 500', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '1000' }] })
            .mockResolvedValueOnce({ rows: [] });

        await request(app).get('/api/waveforms?limit=9999');

        const [, dataParams] = pool.query.mock.calls[1];
        expect(dataParams).toContain(500);
        expect(dataParams).not.toContain(9999);
    });

    it('combines multiple filters in a single query', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await request(app).get(`/api/waveforms?status=complete&device_eui=${DEV_EUI}`);

        const [countSql, countParams] = pool.query.mock.calls[0];
        expect(countSql).toMatch(/status\s*=\s*\$/i);
        expect(countParams).toContain('complete');
        expect(countParams).toContain(DEV_EUI);
    });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:devEui/waveforms — per-device listing
// ---------------------------------------------------------------------------

describe('GET /api/devices/:devEui/waveforms', () => {
    it('returns waveforms for the specified device with X-Total-Count header', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '1' }] })
            .mockResolvedValueOnce({ rows: [makeWaveform()] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/waveforms`);

        expect(res.status).toBe(200);
        expect(res.headers['x-total-count']).toBe('1');
        expect(res.body).toHaveLength(1);
        const [, countParams] = pool.query.mock.calls[0];
        expect(countParams).toContain(DEV_EUI);
    });

    it('accepts a status filter alongside the device_eui constraint', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .get(`/api/devices/${DEV_EUI}/waveforms?status=failed`);

        expect(res.status).toBe(200);
        const [countSql, countParams] = pool.query.mock.calls[0];
        expect(countSql).toMatch(/status\s*=\s*\$/i);
        expect(countParams).toContain('failed');
        expect(countParams).toContain(DEV_EUI);
    });

    it('accepts from, to, limit, and offset query params', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '5' }] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .get(`/api/devices/${DEV_EUI}/waveforms?limit=2&offset=1&from=2024-01-01T00:00:00Z`);

        expect(res.status).toBe(200);
        const [, dataParams] = pool.query.mock.calls[1];
        expect(dataParams).toContain(2);   // limit
        expect(dataParams).toContain(1);   // offset
        expect(dataParams).toContain('2024-01-01T00:00:00Z');
    });

    it('returns 200 with empty array when device has no waveforms', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await request(app).get('/api/devices/UNKNOWN/waveforms');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
        expect(res.headers['x-total-count']).toBe('0');
    });
});

// ---------------------------------------------------------------------------
// GET /api/waveforms/:id/spectra
// ---------------------------------------------------------------------------

describe('GET /api/waveforms/:id/spectra', () => {
    /** Build a float32 LE Buffer from a JS number array. */
    function makeFloat32Buf(values) {
        const buf = Buffer.allocUnsafe(values.length * 4);
        values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
        return buf;
    }

    /** Minimal spectrum DB row with 3 bins. */
    function makeSpectrumRow(axis, spectrumType) {
        return {
            axis,
            spectrum_type: spectrumType,
            num_bins: 3,
            frequency_resolution_hz: 8,
            frequencies: makeFloat32Buf([0, 8, 16]),
            magnitudes:  makeFloat32Buf([0.1, 0.5, 0.2]),
        };
    }

    it('returns 404 when the waveform does not exist', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }); // waveform check returns nothing

        const res = await request(app).get('/api/waveforms/no-such-id/spectra');

        expect(res.status).toBe(404);
    });

    it('returns 200 with an empty array when waveform exists but spectra not yet computed', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] }) // waveform exists
            .mockResolvedValueOnce({ rows: [] });                 // no spectra rows

        const res = await request(app).get('/api/waveforms/uuid-1/spectra');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('returns spectrum rows with camelCase fields and decoded float32 arrays', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] })
            .mockResolvedValueOnce({ rows: [makeSpectrumRow(1, 'acceleration')] });

        const res = await request(app).get('/api/waveforms/uuid-1/spectra');

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);

        const s = res.body[0];
        expect(s.axis).toBe(1);
        expect(s.spectrumType).toBe('acceleration');
        expect(s.numBins).toBe(3);
        expect(s.frequencyResolutionHz).toBe(8);
        expect(Array.isArray(s.frequencies)).toBe(true);
        expect(Array.isArray(s.magnitudes)).toBe(true);
        expect(s.frequencies).toHaveLength(3);
        expect(s.magnitudes).toHaveLength(3);
    });

    it('correctly decodes float32 LE values from BYTEA buffers', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] })
            .mockResolvedValueOnce({ rows: [makeSpectrumRow(1, 'velocity')] });

        const res = await request(app).get('/api/waveforms/uuid-1/spectra');
        const s = res.body[0];

        expect(s.frequencies[0]).toBeCloseTo(0, 3);
        expect(s.frequencies[1]).toBeCloseTo(8, 3);
        expect(s.frequencies[2]).toBeCloseTo(16, 3);
        expect(s.magnitudes[1]).toBeCloseTo(0.5, 3);
    });

    it('returns all spectrum rows for a tri-axis waveform', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] })
            .mockResolvedValueOnce({
                rows: [
                    makeSpectrumRow(1, 'acceleration'),
                    makeSpectrumRow(1, 'velocity'),
                    makeSpectrumRow(1, 'psd'),
                    makeSpectrumRow(1, 'envelope'),
                    makeSpectrumRow(2, 'acceleration'),
                    makeSpectrumRow(2, 'velocity'),
                    makeSpectrumRow(2, 'psd'),
                    makeSpectrumRow(2, 'envelope'),
                    makeSpectrumRow(3, 'acceleration'),
                    makeSpectrumRow(3, 'velocity'),
                    makeSpectrumRow(3, 'psd'),
                    makeSpectrumRow(3, 'envelope'),
                ],
            });

        const res = await request(app).get('/api/waveforms/uuid-1/spectra');

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(12);
        const axes = [...new Set(res.body.map(s => s.axis))].sort();
        expect(axes).toEqual([1, 2, 3]);
    });
});

// ---------------------------------------------------------------------------
// GET /api/waveforms/:id/envelope — on-demand envelope with configurable HP/LP
// ---------------------------------------------------------------------------

describe('GET /api/waveforms/:id/envelope', () => {
    /** Build a minimal single-axis int16 LE waveform buffer (N samples). */
    function makeSineBytes(N, k0 = 4, amplitude = 800) {
        const buf = Buffer.allocUnsafe(N * 2);
        for (let n = 0; n < N; n++) {
            const v = Math.round(amplitude * Math.cos(2 * Math.PI * k0 * n / N));
            buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), n * 2);
        }
        return buf;
    }

    it('returns 404 when the waveform does not exist', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).get('/api/waveforms/no-such/envelope?hp=500&lp=10000');

        expect(res.status).toBe(404);
    });

    it('returns 400 when hp >= lp', async () => {
        const res = await request(app).get('/api/waveforms/uuid-1/envelope?hp=10000&lp=500');

        expect(res.status).toBe(400);
    });

    it('returns 400 when hp or lp is non-numeric', async () => {
        const res = await request(app).get('/api/waveforms/uuid-1/envelope?hp=abc&lp=10000');

        expect(res.status).toBe(400);
    });

    it('returns per-axis envelope spectrum for a complete single-axis waveform', async () => {
        const N = 64;
        const buf = makeSineBytes(N, 8, 800); // carrier at bin 8 = 128 Hz for fs=1024

        pool.query.mockResolvedValueOnce({
            rows: [{
                id:               'uuid-1',
                final_data_bytes: buf,
                final_data:       null,
                metadata:         { axisMask: 0x01, sampleRate: 1024, samplesPerAxis: N },
            }],
        });

        // hp=50 lp=400: the 128 Hz carrier is inside the passband for fs=1024
        const res = await request(app).get('/api/waveforms/uuid-1/envelope?hp=50&lp=400');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(1);

        const s = res.body[0];
        expect(s.axis).toBe(1);
        expect(Array.isArray(s.frequencies)).toBe(true);
        expect(Array.isArray(s.magnitudes)).toBe(true);
        expect(s.numBins).toBeGreaterThan(0);
        expect(typeof s.frequencyResolutionHz).toBe('number');
        s.magnitudes.forEach(m => expect(m).toBeGreaterThanOrEqual(0));
    });
});

// ---------------------------------------------------------------------------
// GET /api/fuota/sessions — filtering
// ---------------------------------------------------------------------------

describe('GET /api/fuota/sessions', () => {
    it('returns all sessions when no filters applied', async () => {
        const sessions = [makeFuotaSession()];
        pool.query.mockResolvedValueOnce({ rows: sessions });

        const res = await request(app).get('/api/fuota/sessions');

        expect(res.status).toBe(200);
        expect(res.body.sessions).toHaveLength(1);
    });

    it('filters sessions by device_eui', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .get(`/api/fuota/sessions?device_eui=${DEV_EUI}`);

        expect(res.status).toBe(200);
        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toMatch(/device_eui\s*=\s*\$/i);
        expect(params).toContain(DEV_EUI);
    });

    it('filters sessions by status', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).get('/api/fuota/sessions?status=failed');

        expect(res.status).toBe(200);
        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toMatch(/status\s*=\s*\$/i);
        expect(params).toContain('failed');
    });

    it('combines device_eui and status filters', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .get(`/api/fuota/sessions?device_eui=${DEV_EUI}&status=complete`);

        expect(res.status).toBe(200);
        const [, params] = pool.query.mock.calls[0];
        expect(params).toContain(DEV_EUI);
        expect(params).toContain('complete');
    });

});

// ---------------------------------------------------------------------------
// Authentication — HTTP layer
// ---------------------------------------------------------------------------

describe('Authentication — HTTP layer', () => {
    beforeEach(() => {
        process.env.API_KEYS_ENABLED = 'true';
    });

    it('returns 401 on a protected endpoint with no Authorization header', async () => {
        const res = await request(app).get('/api/waveforms');
        expect(res.status).toBe(401);
        expect(res.body).toHaveProperty('error');
        // Auth was rejected before any DB query ran
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('returns 401 with a non-Bearer Authorization header', async () => {
        const res = await request(app)
            .get('/api/waveforms')
            .set('Authorization', 'Basic dXNlcjpwYXNz');
        expect(res.status).toBe(401);
    });

    it('returns 401 with an unrecognised API key', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] }); // SELECT → key not found

        const res = await request(app)
            .get('/api/waveforms')
            .set('Authorization', 'Bearer airvibe_not_a_real_key');

        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid api key/i);
    });

    it('returns 200 and serves the route when the key is valid', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ id: 'key-id', label: 'test' }] }) // auth SELECT
            .mockResolvedValueOnce({ rowCount: 1 })                              // last_used_at UPDATE (fire-and-forget)
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })                   // count
            .mockResolvedValueOnce({ rows: [] });                                 // data

        const res = await request(app)
            .get('/api/waveforms')
            .set('Authorization', 'Bearer airvibe_validkey123');

        expect(res.status).toBe(200);
    });

    it('GET /api/health is accessible without auth (exempt path)', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
    });

    it('GET / is accessible without auth (exempt path)', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// POST /api/keys — create API key
// ---------------------------------------------------------------------------

describe('POST /api/keys', () => {
    it('creates a key, returns 201 with id, label, created_at, and the raw key', async () => {
        const createdAt = new Date().toISOString();
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 'new-uuid', label: 'ci-pipeline', created_at: createdAt }],
        });

        const res = await request(app)
            .post('/api/keys')
            .send({ label: 'ci-pipeline' });

        expect(res.status).toBe(201);
        expect(res.body.id).toBe('new-uuid');
        expect(res.body.label).toBe('ci-pipeline');
        expect(res.body.created_at).toBe(createdAt);
        expect(res.body.key).toMatch(/^airvibe_[0-9a-f]{64}$/);
        // Raw key is shown once — key_hash must never be exposed
        expect(res.body).not.toHaveProperty('key_hash');
    });

    it('returns 400 when label is missing', async () => {
        const res = await request(app).post('/api/keys').send({});
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when label is an empty string', async () => {
        const res = await request(app).post('/api/keys').send({ label: '   ' });
        expect(res.status).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// GET /api/keys — list API keys
// ---------------------------------------------------------------------------

describe('GET /api/keys', () => {
    it('returns 200 with id, label, created_at, last_used_at — no key_hash', async () => {
        const createdAt = new Date().toISOString();
        pool.query.mockResolvedValueOnce({
            rows: [
                { id: 'uuid-1', label: 'app-a', created_at: createdAt, last_used_at: null },
                { id: 'uuid-2', label: 'app-b', created_at: createdAt, last_used_at: createdAt },
            ],
        });

        const res = await request(app).get('/api/keys');

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        expect(res.body[0]).not.toHaveProperty('key_hash');
        expect(res.body[0]).toHaveProperty('id', 'uuid-1');
        expect(res.body[0]).toHaveProperty('label', 'app-a');
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/keys/:id — revoke API key
// ---------------------------------------------------------------------------

describe('DELETE /api/keys/:id', () => {
    it('revokes a key and returns 204 No Content', async () => {
        pool.query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app).delete('/api/keys/550e8400-e29b-41d4-a716-446655440000');

        expect(res.status).toBe(204);
        expect(pool.query.mock.calls[0][0]).toMatch(/DELETE FROM api_keys/i);
    });

    it('returns 404 when the key id does not exist', async () => {
        pool.query.mockResolvedValueOnce({ rowCount: 0 });

        const res = await request(app).delete('/api/keys/550e8400-e29b-41d4-a716-446655440000');

        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when the id is not a valid UUID', async () => {
        const res = await request(app).delete('/api/keys/not-a-uuid');

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
        // No DB query should have been made
        expect(pool.query).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// POST /api/keys — label validation
// ---------------------------------------------------------------------------

describe('POST /api/keys — label validation', () => {
    it('returns 400 when label exceeds 255 characters', async () => {
        const res = await request(app)
            .post('/api/keys')
            .send({ label: 'a'.repeat(256) });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });
});

// ---------------------------------------------------------------------------
// GET /api/devices — pagination
// ---------------------------------------------------------------------------

describe('GET /api/devices', () => {
    it('returns X-Total-Count header and paginates results', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '3' }] })
            .mockResolvedValueOnce({ rows: [{ dev_eui: 'AA', last_seen: new Date().toISOString() }] });

        const res = await request(app).get('/api/devices?limit=1&offset=0');

        expect(res.status).toBe(200);
        expect(res.headers['x-total-count']).toBe('3');
        expect(res.body).toHaveLength(1);
    });

    it('runs a COUNT query plus a data query', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await request(app).get('/api/devices');

        expect(pool.query).toHaveBeenCalledTimes(2);
        expect(pool.query.mock.calls[0][0]).toMatch(/SELECT COUNT/i);
    });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:devEui/messages — pagination
// ---------------------------------------------------------------------------

describe('GET /api/devices/:devEui/messages', () => {
    it('returns X-Total-Count header and paginates results', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '10' }] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/messages?limit=5&offset=0`);

        expect(res.status).toBe(200);
        expect(res.headers['x-total-count']).toBe('10');
    });

    it('scopes the COUNT query to the device EUI', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ count: '0' }] })
            .mockResolvedValueOnce({ rows: [] });

        await request(app).get(`/api/devices/${DEV_EUI}/messages`);

        const [countSql, countParams] = pool.query.mock.calls[0];
        expect(countSql).toMatch(/device_eui/i);
        expect(countParams).toContain(DEV_EUI);
    });
});

// ---------------------------------------------------------------------------
// POST /api/fuota/upload — multipart
// ---------------------------------------------------------------------------

describe('POST /api/fuota/upload — multipart', () => {
    it('uploads a valid .bin file and returns sessionId and totalBlocks', async () => {
        const buf = Buffer.alloc(100, 0xAB);
        const res = await request(app)
            .post('/api/fuota/upload')
            .attach('firmware', buf, 'v2.1.bin');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('sessionId');
        expect(res.body).toHaveProperty('totalBlocks');
    });

    it('returns 400 when no file is attached', async () => {
        const res = await request(app)
            .post('/api/fuota/upload');

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when the uploaded file is empty (0 bytes)', async () => {
        const res = await request(app)
            .post('/api/fuota/upload')
            .attach('firmware', Buffer.alloc(0), 'empty.bin');

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when the filename contains invalid characters (e.g. angle brackets)', async () => {
        // Note: HTTP (busboy) strips path separators, so use chars that survive the transport
        // but still fail the server-side regex [a-zA-Z0-9._\-\s]+.
        const res = await request(app)
            .post('/api/fuota/upload')
            .attach('firmware', Buffer.alloc(100, 0xAB), 'fw<bad>.bin');

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });
});

// ---------------------------------------------------------------------------
// OpenAPI spec and Swagger UI
// ---------------------------------------------------------------------------

describe('OpenAPI spec and Swagger UI', () => {
    it('GET /api/openapi.json returns 200 with openapi, info, and paths fields', async () => {
        const res = await request(app).get('/api/openapi.json');

        expect(res.status).toBe(200);
        expect(res.body.openapi).toMatch(/^3\./);
        expect(res.body).toHaveProperty('info');
        expect(res.body).toHaveProperty('paths');
    });

    it('GET /api/openapi.json paths include /waveforms, /devices, /keys, /health, /fuota/sessions', async () => {
        const res = await request(app).get('/api/openapi.json');

        expect(res.status).toBe(200);
        const paths = Object.keys(res.body.paths || {});
        expect(paths).toContain('/waveforms');
        expect(paths).toContain('/devices');
        expect(paths).toContain('/keys');
        expect(paths).toContain('/health');
        expect(paths).toContain('/fuota/sessions');
    });

    it('GET /api/docs/ returns 200 HTML containing "swagger"', async () => {
        const res = await request(app).get('/api/docs/');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/i);
        expect(res.text.toLowerCase()).toContain('swagger');
    });

    it('GET /api/openapi.json is accessible without auth when API_KEYS_ENABLED=true', async () => {
        process.env.API_KEYS_ENABLED = 'true';
        const res = await request(app).get('/api/openapi.json');
        expect(res.status).toBe(200);
    });

    it('GET /api/docs/ is accessible without auth when API_KEYS_ENABLED=true', async () => {
        process.env.API_KEYS_ENABLED = 'true';
        const res = await request(app).get('/api/docs/');
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// PUT /api/fuota/config
// ---------------------------------------------------------------------------

describe('PUT /api/fuota/config', () => {
    const fuotaManager = require('../src/services/FUOTAManager');

    it('returns 200 and echoes maxVerifyRetries when given a valid integer', async () => {
        const res = await request(app)
            .put('/api/fuota/config')
            .send({ maxVerifyRetries: 100 });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ maxVerifyRetries: 100 });
        expect(fuotaManager.setVerifyMaxRetries).toHaveBeenCalledWith(100);
    });

    it('returns 400 when maxVerifyRetries is missing', async () => {
        const res = await request(app)
            .put('/api/fuota/config')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when maxVerifyRetries is not an integer (string)', async () => {
        const res = await request(app)
            .put('/api/fuota/config')
            .send({ maxVerifyRetries: 'lots' });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when maxVerifyRetries is less than 1', async () => {
        const res = await request(app)
            .put('/api/fuota/config')
            .send({ maxVerifyRetries: 0 });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });
});

// ---------------------------------------------------------------------------
// PATCH /api/fuota/sessions/:devEui — live block-interval override
// ---------------------------------------------------------------------------

describe('PATCH /api/fuota/sessions/:devEui', () => {
    const fuotaManager = require('../src/services/FUOTAManager');

    it('returns 200 and echoes devEui + blockIntervalMs on success', async () => {
        fuotaManager.updateBlockInterval.mockReturnValue(true);
        const res = await request(app)
            .patch('/api/fuota/sessions/AABBCCDDEEFF0011')
            .send({ blockIntervalMs: 5000 });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ devEui: 'AABBCCDDEEFF0011', blockIntervalMs: 5000 });
        expect(fuotaManager.updateBlockInterval).toHaveBeenCalledWith('AABBCCDDEEFF0011', 5000);
    });

    it('returns 404 when no active session exists for the devEui', async () => {
        fuotaManager.updateBlockInterval.mockReturnValue(false);
        const res = await request(app)
            .patch('/api/fuota/sessions/NOTFOUND')
            .send({ blockIntervalMs: 5000 });

        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when blockIntervalMs is below 1000', async () => {
        const res = await request(app)
            .patch('/api/fuota/sessions/AABBCCDDEEFF0011')
            .send({ blockIntervalMs: 100 });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 when blockIntervalMs is not an integer', async () => {
        const res = await request(app)
            .patch('/api/fuota/sessions/AABBCCDDEEFF0011')
            .send({ blockIntervalMs: 'fast' });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:devEui/uplink-stats
// ---------------------------------------------------------------------------

describe('GET /api/devices/:devEui/uplink-stats', () => {
    it('returns 404 when device does not exist', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).get('/api/devices/UNKNOWN/uplink-stats');

        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 200 with array of uplink stat rows', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: 8, packet_type: 2,  count: '5900', last_received: '2026-03-13T19:39:00Z' },
                { fport: 8, packet_type: 1,  count: '1200', last_received: '2026-03-13T17:15:00Z' },
                { fport: null, packet_type: null, count: '800', last_received: '2026-03-13T12:00:00Z' },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/uplink-stats`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(3);
    });

    it('assigns correct packet_name for known types', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: 8, packet_type: 2,  count: '100', last_received: null },
                { fport: 8, packet_type: 1,  count: '50',  last_received: null },
                { fport: 8, packet_type: 3,  count: '10',  last_received: null },
                { fport: 8, packet_type: 4,  count: '5',   last_received: null },
                { fport: 8, packet_type: 5,  count: '5',   last_received: null },
                { fport: 8, packet_type: 7,  count: '3',   last_received: null },
                { fport: 8, packet_type: 16, count: '2',   last_received: null },
                { fport: 8, packet_type: 17, count: '2',   last_received: null },
                { fport: 8, packet_type: 18, count: '1',   last_received: null },
                { fport: 8, packet_type: 19, count: '1',   last_received: null },
                { fport: 8, packet_type: 21, count: '1',   last_received: null },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/uplink-stats`);
        const byType = Object.fromEntries(res.body.map(r => [r.packet_type, r.packet_name]));

        expect(byType[2]).toBe('Overall Vibration Report');
        expect(byType[1]).toBe('TWD — Waveform Data Segment');
        expect(byType[3]).toBe('TWIU — Waveform Info Uplink');
        expect(byType[4]).toBe('Sensor Configuration Report');
        expect(byType[5]).toBe('TWF — Waveform Final Segment');
        expect(byType[7]).toBe('Alarm-Triggered Vibration Report');
        expect(byType[16]).toBe('FUOTA Init ACK');
        expect(byType[17]).toBe('FUOTA Verification Response');
        expect(byType[18]).toBe('FUOTA Update Status');
        expect(byType[19]).toBe('FUOTA Stuck Timeout Error');
        expect(byType[21]).toBe('Error — Waveform ACK Timeout');
    });

    it('assigns "No Application Payload" for null fport and null packet_type', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: null, packet_type: null, count: '800', last_received: null },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/uplink-stats`);

        expect(res.body[0].packet_name).toBe('No Application Payload (MAC only)');
    });

    it('assigns an Unknown label for unrecognised packet types', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: 8, packet_type: 99, count: '5', last_received: null },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/uplink-stats`);

        expect(res.body[0].packet_name).toMatch(/unknown/i);
    });

    it('returns count as a number and scopes query to devEui', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: 8, packet_type: 2, count: '42', last_received: '2026-03-13T00:00:00Z' },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/uplink-stats`);

        expect(typeof res.body[0].count).toBe('number');
        expect(res.body[0].count).toBe(42);
        const [statsSql, statsParams] = pool.query.mock.calls[1];
        expect(statsSql).toMatch(/device_eui/i);
        expect(statsParams).toContain(DEV_EUI);
    });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:devEui/downlink-stats
// ---------------------------------------------------------------------------

describe('GET /api/devices/:devEui/downlink-stats', () => {
    it('returns 404 when device does not exist', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app).get('/api/devices/UNKNOWN/downlink-stats');

        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 200 with array of downlink stat rows', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: 25, command_byte: null, count: '5000', last_sent: '2026-03-10T21:12:00Z' },
                { fport: 22, command_byte: '06', count: '1158', last_sent: '2026-03-10T21:48:00Z' },
                { fport: 20, command_byte: '03', count:  '123', last_sent: '2026-03-13T17:15:00Z' },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/downlink-stats`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(3);
    });

    it('assigns correct function_name for known fPorts and command bytes', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: 25, command_byte: null, count: '50', last_sent: null },
                { fport: 22, command_byte: '06', count: '20', last_sent: null },
                { fport: 22, command_byte: '01', count: '10', last_sent: null },
                { fport: 22, command_byte: '02', count: '5',  last_sent: null },
                { fport: 22, command_byte: '05', count: '5',  last_sent: null },
                { fport: 21, command_byte: null, count: '40', last_sent: null },
                { fport: 20, command_byte: '03', count: '15', last_sent: null },
                { fport: 20, command_byte: '01', count: '5',  last_sent: null },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/downlink-stats`);
        const byKey = Object.fromEntries(
            res.body.map(r => [`${r.fport}:${r.command_byte ?? 'null'}`, r.function_name])
        );

        expect(byKey['25:null']).toBe('Update Data Downlink');
        expect(byKey['22:0x06']).toMatch(/Verify Update Data/i);
        expect(byKey['22:0x01']).toMatch(/Request Waveform Info/i);
        expect(byKey['22:0x02']).toMatch(/Request Configuration/i);
        expect(byKey['22:0x05']).toMatch(/Initialize Update Session/i);
        expect(byKey['21:null']).toBe('Missing Waveform Data Segments Downlink');
        expect(byKey['20:0x03']).toMatch(/Waveform Info ACK/i);
        expect(byKey['20:0x01']).toMatch(/Waveform Data ACK/i);
    });

    it('formats command_byte as 0xNN uppercase in the response', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: 22, command_byte: '06', count: '10', last_sent: null },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/downlink-stats`);

        expect(res.body[0].command_byte).toBe('0x06');
    });

    it('only extracts command_byte for fPorts 20 and 22 — not for 21, 25, 30, 31', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [] });

        await request(app).get(`/api/devices/${DEV_EUI}/downlink-stats`);

        const [statsSql] = pool.query.mock.calls[1];
        expect(statsSql).toMatch(/fport in \(20, 22\)/i);
    });

    it('returns count as a number and scopes query to devEui', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ dev_eui: DEV_EUI }] })
            .mockResolvedValueOnce({ rows: [
                { fport: 25, command_byte: null, count: '99', last_sent: '2026-03-10T21:00:00Z' },
            ] });

        const res = await request(app).get(`/api/devices/${DEV_EUI}/downlink-stats`);

        expect(typeof res.body[0].count).toBe('number');
        expect(res.body[0].count).toBe(99);
        const [statsSql, statsParams] = pool.query.mock.calls[1];
        expect(statsSql).toMatch(/device_eui/i);
        expect(statsParams).toContain(DEV_EUI);
    });
});
