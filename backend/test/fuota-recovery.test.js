'use strict';

// ---------------------------------------------------------------------------
// Mock all external dependencies BEFORE requiring FUOTAManager.
// ---------------------------------------------------------------------------

jest.mock('../src/db', () => ({
    pool: { query: jest.fn() },
}));

jest.mock('../src/mqttClient', () => ({
    publish: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/services/AuditLogger', () => ({
    log: jest.fn(),
}));

jest.mock('../src/services/networkServerClient', () => ({
    switchToClassC: jest.fn().mockResolvedValue(null),
    restoreClass: jest.fn().mockResolvedValue(null),
    configured: false,
    type: 'thingpark',
}));

// Freeze timers so setInterval/_sessionTimeout/ACK timeout don't fire during tests.
jest.useFakeTimers();

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { pool } = require('../src/db');
const mqttClient = require('../src/mqttClient');
const fuotaManager = require('../src/services/FUOTAManager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockIo = {
    emit: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
};

/** Build a minimal fuota_sessions DB row that looks like it has saved firmware. */
function makeRow(devEui) {
    return {
        id: `uuid-${devEui}`,
        device_eui: devEui,
        firmware_name: 'fw.bin',
        firmware_size: 49,
        total_blocks: 1,
        block_interval_ms: 10000,
        verify_attempts: 0,
        firmware_data: Buffer.alloc(49), // 49 bytes → exactly 1 block
    };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
    jest.clearAllMocks();
    fuotaManager.activeSessions.clear();
    // Default: MQTT is connected, all pool queries return empty result sets.
    mqttClient.isConnected.mockReturnValue(true);
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ---------------------------------------------------------------------------
// FUOTAManager startup recovery
// ---------------------------------------------------------------------------

describe('FUOTAManager startup recovery', () => {
    it('adds both sessions to activeSessions when MQTT is connected', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [makeRow('DEAD000000000001'), makeRow('DEAD000000000002')],
        });

        await fuotaManager.init(mockIo);

        expect(fuotaManager.activeSessions.has('DEAD000000000001')).toBe(true);
        expect(fuotaManager.activeSessions.has('DEAD000000000002')).toBe(true);
    });

    it('continues recovering subsequent sessions when one session init downlink throws', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [makeRow('DEAD000000000001'), makeRow('DEAD000000000002')],
        });

        // First publish() call (session 1's init downlink) throws — simulates the
        // real-world race where MQTT isn't connected yet at startup.
        mqttClient.publish
            .mockImplementationOnce(() => { throw new Error('MQTT Client not connected'); })
            .mockReturnValue(undefined);

        await fuotaManager.init(mockIo);

        // Session 1 failed and should have been cleaned up; session 2 must be recovered.
        expect(fuotaManager.activeSessions.has('DEAD000000000001')).toBe(false);
        expect(fuotaManager.activeSessions.has('DEAD000000000002')).toBe(true);
    });

    it('skips waiting_ack and starts block sending directly without an init downlink', async () => {
        // Use 2-block firmware so _sendAllBlocks pauses on sleep() after block 0,
        // letting init() return with session state already at 'sending_blocks'.
        const twoBlockRow = {
            ...makeRow('DEAD000000000001'),
            firmware_size: 98,
            total_blocks: 2,
            firmware_data: Buffer.alloc(98),
        };
        pool.query.mockResolvedValueOnce({ rows: [twoBlockRow] });
        mqttClient.publish.mockReturnValue(undefined);

        await fuotaManager.init(mockIo);

        const session = fuotaManager.activeSessions.get('DEAD000000000001');
        expect(session).toBeDefined();
        // Must be 'sending_blocks', not 'waiting_ack' (which would require a 0x10 ACK)
        expect(session.state).toBe('sending_blocks');
        // No fPort 22 init downlink should have been published
        const port22Calls = mqttClient.publish.mock.calls.filter(
            ([, msg]) => JSON.parse(msg).DevEUI_downlink.FPort === 22
        );
        expect(port22Calls).toHaveLength(0);
    });

    it('resumes from blocks_sent in DB row, not from block 0', async () => {
        // 3-block firmware with 1 block already recorded in the DB row.
        // _sendAllBlocks should start at block index 1 (skip block 0) and
        // pause at the inter-block sleep, letting init() return.
        const partialRow = {
            ...makeRow('DEAD000000000001'),
            firmware_size: 147,   // 3 × 49 bytes
            total_blocks: 3,
            blocks_sent: 1,       // block 0 already sent in a previous run
            firmware_data: Buffer.alloc(147),
        };
        pool.query.mockResolvedValueOnce({ rows: [partialRow] });
        mqttClient.publish.mockReturnValue(undefined);

        await fuotaManager.init(mockIo);

        const session = fuotaManager.activeSessions.get('DEAD000000000001');
        expect(session).toBeDefined();
        expect(session.state).toBe('sending_blocks');
        // In-memory blocksSent must reflect the DB value, not be reset to 0.
        expect(session.blocksSent).toBeGreaterThanOrEqual(1);

        // Only block 1 should have been published — block 0 must be skipped.
        const port25Calls = mqttClient.publish.mock.calls.filter(
            ([, msg]) => JSON.parse(msg).DevEUI_downlink.FPort === 25
        );
        expect(port25Calls).toHaveLength(1);

        // The payload starts with block number 1 in 2-byte little-endian: 01 00
        const payloadHex = JSON.parse(port25Calls[0][1]).DevEUI_downlink.payload_hex;
        expect(payloadHex.startsWith('0100')).toBe(true);
    });

    it('skips sessions with no firmware_data and continues to valid sessions', async () => {
        const noFirmware = { ...makeRow('DEAD000000000001'), firmware_data: null };
        pool.query.mockResolvedValueOnce({
            rows: [noFirmware, makeRow('DEAD000000000002')],
        });

        await fuotaManager.init(mockIo);

        expect(fuotaManager.activeSessions.has('DEAD000000000001')).toBe(false);
        expect(fuotaManager.activeSessions.has('DEAD000000000002')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Bug fixes: verify-state guard (Bug A) and post-resend delay (Bug B)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared helpers for verify/resend tests
// ---------------------------------------------------------------------------

/** Build a minimal session for direct planting into activeSessions. */
function makeVerifySession(devEui, state, verifyAttempts = 1) {
    return {
        devEui,
        dbId: null,                          // skip _updateDb DB round-trips
        state,
        blocks: [Buffer.alloc(49)],           // 1 block at index 0
        blocksSent: 1,
        blocksSentAtStart: 0,
        blocksResentSoFar: 0,
        confirmedBlocks: new Set(),
        totalBlocks: 1,
        blockIntervalMs: 10000,
        verifyAttempts,
        lastMissedCount: 0,
        lastMissedBlocks: [],
        firmwareName: 'fw.bin',
        firmwareSize: 49,
        error: null,
        aborted: false,
        classCConfigured: false,
        originalClass: null,
        _ackTimeout: null,
        _verifyTimeout: null,
        _sessionTimeout: null,
        startedAt: Date.now(),
    };
}

/** 0x11 payload: missedFlag=0, count=1, missed block#0 (LE 16-bit). */
const VERIFY_UPLINK_1_MISSED = Buffer.from([0x11, 0x00, 0x01, 0x00, 0x00]);

function makeUplink(devEui, payloadBuf) {
    return {
        topic: `mqtt/things/${devEui}/uplink`,
        msg: JSON.stringify({ DevEUI_uplink: { payload_hex: payloadBuf.toString('hex') } }),
    };
}

describe('FUOTAManager verify-phase bug fixes', () => {
    beforeEach(() => { fuotaManager.io = mockIo; });
    afterEach(() => { fuotaManager.io = null; });

    // Bug A: _handleVerifyUplink must only accept 'verifying', not 'resending'
    it('Bug A: ignores 0x11 uplink when session is already in resending state', async () => {
        const DEV = 'DEAD000000000010';
        fuotaManager.activeSessions.set(DEV, makeVerifySession(DEV, 'resending'));

        const { topic, msg } = makeUplink(DEV, VERIFY_UPLINK_1_MISSED);
        fuotaManager.processPacket(topic, msg);

        // Flush microtasks — enough for any triggered async work to reach its first suspension
        await Promise.resolve();
        await Promise.resolve();

        // No FPort 25 block should be re-sent (a concurrent resend must not be spawned)
        const port25Calls = mqttClient.publish.mock.calls.filter(
            ([, m]) => JSON.parse(m).DevEUI_downlink.FPort === 25
        );
        expect(port25Calls).toHaveLength(0);
    });

    // Bug B: _resendMissedBlocks must delay FUOTA_RESEND_VERIFY_DELAY_MS before re-verifying
    it('Bug B: sends FPort 25 resend block immediately but delays FPort 22 verify by FUOTA_RESEND_VERIFY_DELAY_MS', async () => {
        const DEV = 'DEAD000000000011';
        // verifyAttempts=1 so _sendVerify skips its own FUOTA_VERIFY_PRE_DELAY_MS pre-delay
        fuotaManager.activeSessions.set(DEV, makeVerifySession(DEV, 'verifying', 1));

        const { topic, msg } = makeUplink(DEV, VERIFY_UPLINK_1_MISSED);
        fuotaManager.processPacket(topic, msg);

        // Let _resendMissedBlocks run through _waitForMqtt and publish the FPort 25 block,
        // then pause at the resend-verify delay sleep.
        await Promise.resolve();
        await Promise.resolve();

        // The resend block (FPort 25) must have been sent already
        const port25Calls = mqttClient.publish.mock.calls.filter(
            ([, m]) => JSON.parse(m).DevEUI_downlink.FPort === 25
        );
        expect(port25Calls).toHaveLength(1);

        // FPort 22 verify must NOT yet be sent (blocked by the resend-verify delay)
        const port22Before = mqttClient.publish.mock.calls.filter(
            ([, m]) => JSON.parse(m).DevEUI_downlink.FPort === 22
        );
        expect(port22Before).toHaveLength(0);

        // Advance past the default 30 s resend-verify delay
        jest.advanceTimersByTime(30000);
        await Promise.resolve();
        await Promise.resolve();

        // Now FPort 22 verify must be published
        const port22After = mqttClient.publish.mock.calls.filter(
            ([, m]) => JSON.parse(m).DevEUI_downlink.FPort === 22
        );
        expect(port22After).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// FUOTAManager.getActiveSessions() — ETA data contract
// ---------------------------------------------------------------------------

describe('FUOTAManager.getActiveSessions() ETA fields', () => {
    it('returns startedAt as a ms-epoch number, not an ISO string', () => {
        // Direct manipulation: plant a session in activeSessions and verify the
        // shape of what getActiveSessions() serialises for the REST response.
        const TS = 1740504126238; // arbitrary ms epoch
        fuotaManager.activeSessions.set('DEAD000000000001', {
            devEui: 'DEAD000000000001',
            state: 'sending_blocks',
            firmwareName: 'fw.bin',
            firmwareSize: 49,
            blocks: [],
            blocksSent: 50,
            blocksSentAtStart: 0,
            totalBlocks: 3877,
            blockIntervalMs: 21000,
            verifyAttempts: 0,
            lastMissedCount: 0,
            lastMissedBlocks: [],
            error: null,
            aborted: false,
            classCConfigured: false,
            originalClass: null,
            _ackTimeout: null,
            _verifyTimeout: null,
            _sessionTimeout: null,
            startedAt: TS,
        });

        const sessions = fuotaManager.getActiveSessions();
        expect(sessions).toHaveLength(1);
        // Must be a number so Date.now() - startedAt works in the frontend
        expect(typeof sessions[0].startedAt).toBe('number');
        expect(sessions[0].startedAt).toBe(TS);
    });

    it('includes blocksSentAtStart = 0 for a fresh session', () => {
        fuotaManager.activeSessions.set('DEAD000000000001', {
            devEui: 'DEAD000000000001',
            state: 'sending_blocks',
            firmwareName: 'fw.bin',
            firmwareSize: 49,
            blocks: [],
            blocksSent: 50,
            blocksSentAtStart: 0,
            totalBlocks: 3877,
            blockIntervalMs: 21000,
            verifyAttempts: 0,
            lastMissedCount: 0,
            lastMissedBlocks: [],
            error: null,
            aborted: false,
            classCConfigured: false,
            originalClass: null,
            _ackTimeout: null,
            _verifyTimeout: null,
            _sessionTimeout: null,
            startedAt: Date.now(),
        });

        const sessions = fuotaManager.getActiveSessions();
        expect(typeof sessions[0].blocksSentAtStart).toBe('number');
        expect(sessions[0].blocksSentAtStart).toBe(0);
    });

    it('includes blocksSentAtStart = resume offset for a recovered session', async () => {
        const partialRow = {
            ...makeRow('DEAD000000000001'),
            firmware_size: 147,
            total_blocks: 3,
            blocks_sent: 2713,
            firmware_data: Buffer.alloc(147),
        };
        pool.query.mockResolvedValueOnce({ rows: [partialRow] });
        mqttClient.publish.mockReturnValue(undefined);

        await fuotaManager.init(mockIo);

        const sessions = fuotaManager.getActiveSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].blocksSentAtStart).toBe(2713);
    });
});

// ---------------------------------------------------------------------------
// Resend progress tracking (blocksResentSoFar)
// ---------------------------------------------------------------------------

describe('FUOTAManager resend progress tracking', () => {
    beforeEach(() => { fuotaManager.io = mockIo; });
    afterEach(() => { fuotaManager.io = null; });

    it('emits blocksResentSoFar=1 after first block of a two-block resend is sent', async () => {
        const DEV = 'DEAD000000000012';
        const session = {
            ...makeVerifySession(DEV, 'verifying', 1),
            blocks: [Buffer.alloc(49), Buffer.alloc(49)],
            totalBlocks: 2,
        };
        fuotaManager.activeSessions.set(DEV, session);

        // 0x11: missedFlag=0, count=2, block#0 LE and block#1 LE
        const twoMissed = Buffer.from([0x11, 0x00, 0x02, 0x00, 0x00, 0x01, 0x00]);
        const { topic, msg } = makeUplink(DEV, twoMissed);
        fuotaManager.processPacket(topic, msg);

        // Let _resendMissedBlocks send block 0, then pause at sleep(blockIntervalMs)
        await Promise.resolve();
        await Promise.resolve();

        const progressEmits = mockIo.emit.mock.calls
            .filter(([ev]) => ev === 'fuota:progress')
            .map(([, p]) => p);

        // Must have emitted blocksResentSoFar=1 after first missed block resent
        expect(progressEmits.some(p => p.blocksResentSoFar === 1)).toBe(true);
    });

    it('includes blocksResentSoFar=0 in getActiveSessions before any resend', () => {
        const DEV = 'DEAD000000000013';
        fuotaManager.activeSessions.set(DEV, makeVerifySession(DEV, 'verifying', 1));

        const sessions = fuotaManager.getActiveSessions();
        expect(sessions).toHaveLength(1);
        expect(typeof sessions[0].blocksResentSoFar).toBe('number');
        expect(sessions[0].blocksResentSoFar).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// confirmedBlocks accumulation — tracks device-confirmed received blocks
// ---------------------------------------------------------------------------

describe('FUOTAManager confirmedBlocks accumulation', () => {
    beforeEach(() => { fuotaManager.io = mockIo; });
    afterEach(() => { fuotaManager.io = null; });

    // Helper: build session with N blocks all sent
    function makeNBlockSession(devEui, n) {
        return {
            ...makeVerifySession(devEui, 'verifying', 1),
            blocks: Array.from({ length: n }, () => Buffer.alloc(49)),
            totalBlocks: n,
            blocksSent: n,
        };
    }

    it('missedFlag=0: confirms all sent blocks except those in the missed list', async () => {
        const DEV = 'DEAD000000000020';
        fuotaManager.activeSessions.set(DEV, makeNBlockSession(DEV, 4));

        // 0x11: missedFlag=0 (complete list), count=1, block#2 missed
        const payload = Buffer.from([0x11, 0x00, 0x01, 0x02, 0x00]);
        fuotaManager.processPacket(`mqtt/things/${DEV}/uplink`,
            JSON.stringify({ DevEUI_uplink: { payload_hex: payload.toString('hex') } }));
        await Promise.resolve();

        const s = fuotaManager.activeSessions.get(DEV);
        // 4 blocks sent, block 2 missed → blocks 0,1,3 confirmed
        expect(s.confirmedBlocks.has(0)).toBe(true);
        expect(s.confirmedBlocks.has(1)).toBe(true);
        expect(s.confirmedBlocks.has(2)).toBe(false);  // missed
        expect(s.confirmedBlocks.has(3)).toBe(true);
    });

    it('missedFlag=1: confirms only blocks in 0..maxMissed that are not missed', async () => {
        const DEV = 'DEAD000000000021';
        fuotaManager.activeSessions.set(DEV, makeNBlockSession(DEV, 6));

        // 0x11: missedFlag=1 (partial list), count=1, block#3 missed
        const payload = Buffer.from([0x11, 0x01, 0x01, 0x03, 0x00]);
        fuotaManager.processPacket(`mqtt/things/${DEV}/uplink`,
            JSON.stringify({ DevEUI_uplink: { payload_hex: payload.toString('hex') } }));
        await Promise.resolve();

        const s = fuotaManager.activeSessions.get(DEV);
        // 6 blocks sent, missedFlag=1, maxMissed=3 → only confirm 0..3 except block 3
        expect(s.confirmedBlocks.has(0)).toBe(true);
        expect(s.confirmedBlocks.has(1)).toBe(true);
        expect(s.confirmedBlocks.has(2)).toBe(true);
        expect(s.confirmedBlocks.has(3)).toBe(false); // missed
        expect(s.confirmedBlocks.has(4)).toBe(false); // beyond maxMissed — not confirmed
        expect(s.confirmedBlocks.has(5)).toBe(false); // beyond maxMissed — not confirmed
    });

    it('getActiveSessions returns confirmedRanges as sorted [lo,hi] pairs', () => {
        const DEV = 'DEAD000000000022';
        const session = makeVerifySession(DEV, 'verifying', 1);
        session.confirmedBlocks = new Set([0, 1, 2, 5, 6]);
        fuotaManager.activeSessions.set(DEV, session);

        const sessions = fuotaManager.getActiveSessions();
        expect(sessions[0].confirmedRanges).toEqual([[0, 2], [5, 6]]);
    });
});

// ---------------------------------------------------------------------------
// Confirmed downlinks — FUOTA data blocks and verify commands must be confirmed
// ---------------------------------------------------------------------------

describe('FUOTAManager confirmed downlinks', () => {
    beforeEach(() => { fuotaManager.io = mockIo; });
    afterEach(() => { fuotaManager.io = null; });

    it('_sendAllBlocks publishes FPort 25 blocks with Confirmed: 1', async () => {
        pool.query.mockResolvedValueOnce({ rows: [makeRow('DEAD000000000030')] });
        mqttClient.publish.mockReturnValue(undefined);

        await fuotaManager.init(mockIo);

        const port25Calls = mqttClient.publish.mock.calls.filter(
            ([, msg]) => JSON.parse(msg).DevEUI_downlink.FPort === 25
        );
        expect(port25Calls.length).toBeGreaterThan(0);
        const dl = JSON.parse(port25Calls[0][1]).DevEUI_downlink;
        expect(dl.Confirmed).toBe(1);
    });

    it('_resendMissedBlocks publishes FPort 25 resend blocks with Confirmed: 1', async () => {
        const DEV = 'DEAD000000000031';
        fuotaManager.activeSessions.set(DEV, makeVerifySession(DEV, 'verifying', 1));

        const { topic, msg } = makeUplink(DEV, VERIFY_UPLINK_1_MISSED);
        fuotaManager.processPacket(topic, msg);
        await Promise.resolve();
        await Promise.resolve();

        const port25Calls = mqttClient.publish.mock.calls.filter(
            ([, m]) => JSON.parse(m).DevEUI_downlink.FPort === 25
        );
        expect(port25Calls).toHaveLength(1);
        const dl = JSON.parse(port25Calls[0][1]).DevEUI_downlink;
        expect(dl.Confirmed).toBe(1);
    });

    it('_sendVerify publishes FPort 22 verify command (0x0600) with Confirmed: 1', async () => {
        const DEV = 'DEAD000000000032';
        fuotaManager.activeSessions.set(DEV, makeVerifySession(DEV, 'verifying', 1));

        const { topic, msg } = makeUplink(DEV, VERIFY_UPLINK_1_MISSED);
        fuotaManager.processPacket(topic, msg);
        await Promise.resolve();
        await Promise.resolve();

        // Advance past the 30 s resend-verify delay so the next verify fires
        jest.advanceTimersByTime(30000);
        await Promise.resolve();
        await Promise.resolve();

        const verifyCalls = mqttClient.publish.mock.calls.filter(([, m]) => {
            const dl = JSON.parse(m).DevEUI_downlink;
            return dl.FPort === 22 && dl.payload_hex === '0600';
        });
        expect(verifyCalls.length).toBeGreaterThan(0);
        const dl = JSON.parse(verifyCalls[0][1]).DevEUI_downlink;
        expect(dl.Confirmed).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Init downlink fixes:
//   1. _sendInitDownlink uses confirmed=true
//   2. 0x0200 config request moved to _handleInitAck (not sent at session start)
// ---------------------------------------------------------------------------

describe('FUOTAManager init downlink fixes', () => {
    beforeEach(() => { fuotaManager.io = mockIo; });
    afterEach(() => { fuotaManager.io = null; });

    it('_sendInitDownlink sends FPort 22 init payload (0x0500) with Confirmed: 1', () => {
        const DEV = 'DEAD000000000040';
        const session = {
            devEui: DEV,
            dbId: null,
            firmwareSize: 49,
            state: 'initializing',
            blockIntervalMs: 10000,
            _ackTimeout: null,
            _verifyTimeout: null,
            _sessionTimeout: null,
        };
        fuotaManager.activeSessions.set(DEV, session);

        fuotaManager._sendInitDownlink(session);

        const initCall = mqttClient.publish.mock.calls.find(([, m]) => {
            const dl = JSON.parse(m).DevEUI_downlink;
            return dl.FPort === 22 && dl.payload_hex.startsWith('0500');
        });
        expect(initCall).toBeDefined();
        expect(JSON.parse(initCall[1]).DevEUI_downlink.Confirmed).toBe(1);

        // Cleanup — prevent the ack-timeout from leaking into other tests
        clearTimeout(session._ackTimeout);
        fuotaManager.activeSessions.delete(DEV);
    });

    it('_handleInitAck sends 0x0200 config request on FPort 22', async () => {
        const DEV = 'DEAD000000000041';
        // blocksSent=1 == blocks.length → _sendAllBlocks loop skipped entirely,
        // goes straight to _sendVerify which suspends on its pre-delay sleep.
        const session = { ...makeVerifySession(DEV, 'waiting_ack', 0) };
        fuotaManager.activeSessions.set(DEV, session);

        fuotaManager.processPacket(
            `mqtt/things/${DEV}/uplink`,
            JSON.stringify({ DevEUI_uplink: { payload_hex: '1000' } })
        );
        await Promise.resolve();
        await Promise.resolve();

        const configCalls = mqttClient.publish.mock.calls.filter(([, m]) => {
            const dl = JSON.parse(m).DevEUI_downlink;
            return dl.FPort === 22 && dl.payload_hex === '0200';
        });
        expect(configCalls).toHaveLength(1);
    });

    it('startSession does NOT send 0x0200 config request before 0x10 ACK', async () => {
        const DEV = 'DEAD000000000042';
        const { sessionId } = fuotaManager.storeFirmware('test.bin', Buffer.alloc(49));

        // Sequence of pool.query calls in startSession:
        // 1. resolveClassCProfile → SELECT metadata ism_band
        // 2. INSERT INTO devices (upsert)
        // 3. INSERT INTO fuota_sessions RETURNING id
        // 4. UPDATE fuota_sessions SET firmware_data
        pool.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [{ id: 'uuid-42' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        await fuotaManager.startSession(sessionId, DEV);

        const configCalls = mqttClient.publish.mock.calls.filter(([, m]) => {
            const dl = JSON.parse(m).DevEUI_downlink;
            return dl.FPort === 22 && dl.payload_hex === '0200';
        });
        expect(configCalls).toHaveLength(0);

        // Cleanup
        const s = fuotaManager.activeSessions.get(DEV);
        if (s) { fuotaManager._clearTimeouts(s); fuotaManager.activeSessions.delete(DEV); }
    });

    it('config request (0x0200) in _handleInitAck uses Confirmed: 1', async () => {
        const DEV = 'DEAD000000000043';
        const session = { ...makeVerifySession(DEV, 'waiting_ack', 0) };
        fuotaManager.activeSessions.set(DEV, session);

        fuotaManager.processPacket(
            `mqtt/things/${DEV}/uplink`,
            JSON.stringify({ DevEUI_uplink: { payload_hex: '1000' } })
        );
        await Promise.resolve();
        await Promise.resolve();

        const configCall = mqttClient.publish.mock.calls.find(([, m]) => {
            const dl = JSON.parse(m).DevEUI_downlink;
            return dl.FPort === 22 && dl.payload_hex === '0200';
        });
        expect(configCall).toBeDefined();
        expect(JSON.parse(configCall[1]).DevEUI_downlink.Confirmed).toBe(1);
    });
});
