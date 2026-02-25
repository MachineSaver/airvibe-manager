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
}));

jest.mock('../src/services/WaveformManager', () => ({
    processPacket: jest.fn(),
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
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
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
