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

        // First publish() call (session 1's block send) throws — simulates the
        // real-world race where MQTT isn't connected yet at startup.
        mqttClient.publish
            .mockImplementationOnce(() => { throw new Error('MQTT Client not connected'); })
            .mockReturnValue(undefined);

        await fuotaManager.init(mockIo);
        // Flush the microtask queue so the _failSession chain for session 1
        // (publish throw → _sendAllBlocks reject → .catch → _failSession → _updateDb await →
        // activeSessions.delete) completes before asserting.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

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

    it('uses stored original_class_info from DB and does not call switchToClassC', async () => {
        const networkClient = require('../src/services/networkServerClient');
        const classInfo = { deviceRef: 'ref-123', originalProfileId: 'LORA/GenericA.1.0.4b_FCC' };
        const rowWithClassInfo = {
            ...makeRow('DEAD000000000005'),
            original_class_info: classInfo,
        };
        pool.query.mockResolvedValueOnce({ rows: [rowWithClassInfo] });
        mqttClient.publish.mockReturnValue(undefined);

        await fuotaManager.init(mockIo);

        // switchToClassC must NOT be called — device is already in Class C mid-FUOTA
        expect(networkClient.switchToClassC).not.toHaveBeenCalled();
        const session = fuotaManager.activeSessions.get('DEAD000000000005');
        expect(session).toBeDefined();
        expect(session.classCConfigured).toBe(true);
        expect(session.originalClass).toEqual(classInfo);
    });
});

describe('FUOTAManager startSession Class C persistence', () => {
    beforeEach(() => { fuotaManager.io = mockIo; });
    afterEach(() => { fuotaManager.io = null; });

    it('persists original_class_info to DB after a successful Class C switch', async () => {
        const DEV = 'DEAD000000000050';
        const networkClient = require('../src/services/networkServerClient');
        const { sessionId } = fuotaManager.storeFirmware('test.bin', Buffer.alloc(49));
        const classInfo = { deviceRef: 'ref-456', originalProfileId: 'LORA/GenericA.1.0.4b_FCC' };
        networkClient.switchToClassC.mockResolvedValueOnce({ originalClass: classInfo });

        const freshTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        pool.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // INSERT devices
            .mockResolvedValueOnce({ rows: [{ id: 'uuid-50' }] })          // INSERT fuota_sessions
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })               // UPDATE firmware_data
            .mockResolvedValueOnce({ rows: [{ config_updated_at: freshTime }] }) // prefillConfig SELECT
            .mockResolvedValueOnce({ rows: [] })                            // resolveClassCProfile SELECT
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });              // UPDATE original_class_info

        await fuotaManager.startSession(sessionId, DEV);

        const originalClassCall = pool.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('original_class_info')
        );
        expect(originalClassCall).toBeDefined();
        expect(originalClassCall[1][0]).toBe(JSON.stringify(classInfo));

        // Cleanup
        const s = fuotaManager.activeSessions.get(DEV);
        if (s) { fuotaManager._clearTimeouts(s); fuotaManager.activeSessions.delete(DEV); }
    });

    it('does not make an original_class_info DB call when switchToClassC returns null', async () => {
        const DEV = 'DEAD000000000051';
        const { sessionId } = fuotaManager.storeFirmware('test.bin', Buffer.alloc(49));
        // switchToClassC already mocked to return null by default

        const freshTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        pool.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [{ id: 'uuid-51' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ config_updated_at: freshTime }] })
            .mockResolvedValueOnce({ rows: [] });

        await fuotaManager.startSession(sessionId, DEV);

        const originalClassCall = pool.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('original_class_info')
        );
        expect(originalClassCall).toBeUndefined();

        const s = fuotaManager.activeSessions.get(DEV);
        if (s) { fuotaManager._clearTimeouts(s); fuotaManager.activeSessions.delete(DEV); }
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
        configPollAttempt: 0,
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
// Init downlink
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

    it('startSession does NOT send 0x0200 config request (fresh config)', async () => {
        const DEV = 'DEAD000000000042';
        const { sessionId } = fuotaManager.storeFirmware('test.bin', Buffer.alloc(49));

        // config_updated_at is 1h ago (fresh < 6h) → _prefillConfig skips poll
        const freshTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        // Sequence of pool.query calls in startSession:
        // 1. INSERT INTO devices (upsert)
        // 2. INSERT INTO fuota_sessions RETURNING id
        // 3. UPDATE fuota_sessions SET firmware_data
        // 4. _prefillConfig → SELECT config_updated_at (fresh → skip poll)
        // 5. resolveClassCProfile → SELECT metadata ism_band
        pool.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [{ id: 'uuid-42' }] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ config_updated_at: freshTime }] })
            .mockResolvedValueOnce({ rows: [] });

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
});

// ---------------------------------------------------------------------------
// Pre-flight config poll (_prefillConfig)
// ---------------------------------------------------------------------------

describe('FUOTAManager config pre-flight poll', () => {
    // Default poll wait from env (or 5 min)
    const POLL_WAIT_MS = parseInt(process.env.FUOTA_CONFIG_POLL_WAIT_MS) || 5 * 60 * 1000;

    beforeEach(() => { fuotaManager.io = mockIo; });
    afterEach(() => { fuotaManager.io = null; });

    it('skips config poll when config_updated_at is fresh (< 6h)', async () => {
        const DEV = 'DEAD000000000050';
        const session = { ...makeVerifySession(DEV, 'initializing', 0) };
        fuotaManager.activeSessions.set(DEV, session);

        // 1h ago — well within the 6h freshness window
        const freshTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        pool.query.mockResolvedValueOnce({ rows: [{ config_updated_at: freshTime }] });

        await fuotaManager._prefillConfig(DEV);

        // No 0x0200 config request should have been sent
        const pollCalls = mqttClient.publish.mock.calls.filter(([, m]) => {
            const dl = JSON.parse(m).DevEUI_downlink;
            return dl.FPort === 22 && dl.payload_hex === '0200';
        });
        expect(pollCalls).toHaveLength(0);
        // Session state must be unchanged
        expect(session.state).toBe('initializing');

        fuotaManager.activeSessions.delete(DEV);
    });

    it('sends exactly 3 config requests when config is stale and device never responds', async () => {
        const DEV = 'DEAD000000000051';
        const session = { ...makeVerifySession(DEV, 'initializing', 0) };
        fuotaManager.activeSessions.set(DEV, session);

        // 8h ago — stale (older than 6h)
        const staleTime = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

        // 4 pool.query calls: initial check + re-check after each of 3 attempts
        pool.query
            .mockResolvedValueOnce({ rows: [{ config_updated_at: staleTime }] })
            .mockResolvedValueOnce({ rows: [{ config_updated_at: staleTime }] })
            .mockResolvedValueOnce({ rows: [{ config_updated_at: staleTime }] })
            .mockResolvedValueOnce({ rows: [{ config_updated_at: staleTime }] });

        const prefillPromise = fuotaManager._prefillConfig(DEV);

        // Flush initial pool.query → loop entered, first _sendDownlink sent, sleep started
        await Promise.resolve();

        // Advance through attempt 1, 2, 3 (each: timer → sleep resolves, pool.query re-check)
        for (let i = 0; i < 3; i++) {
            jest.advanceTimersByTime(POLL_WAIT_MS);
            await Promise.resolve(); // flush sleep → runs until pool.query re-check suspends
            await Promise.resolve(); // flush pool.query → runs until next sleep (or return)
        }

        await prefillPromise;

        const pollCalls = mqttClient.publish.mock.calls.filter(([, m]) => {
            const dl = JSON.parse(m).DevEUI_downlink;
            return dl.FPort === 22 && dl.payload_hex === '0200';
        });
        expect(pollCalls).toHaveLength(3);
        // All 3 must be confirmed downlinks
        pollCalls.forEach(([, m]) => {
            expect(JSON.parse(m).DevEUI_downlink.Confirmed).toBe(1);
        });

        fuotaManager.activeSessions.delete(DEV);
    });

    it('stops after one successful poll when device responds with fresh config', async () => {
        const DEV = 'DEAD000000000052';
        const session = { ...makeVerifySession(DEV, 'initializing', 0) };
        fuotaManager.activeSessions.set(DEV, session);

        const staleTime = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
        // Simulated fresh response: 30s ago (device responded ~30s before the re-check runs)
        const freshResponse = new Date(Date.now() - 30 * 1000).toISOString();

        // 2 pool.query calls: initial check (stale) + re-check after attempt 1 (fresh)
        pool.query
            .mockResolvedValueOnce({ rows: [{ config_updated_at: staleTime }] })
            .mockResolvedValueOnce({ rows: [{ config_updated_at: freshResponse }] });

        const prefillPromise = fuotaManager._prefillConfig(DEV);

        // Flush initial pool.query → loop, _sendDownlink, sleep
        await Promise.resolve();

        // Advance through attempt 1 sleep
        jest.advanceTimersByTime(POLL_WAIT_MS);
        await Promise.resolve(); // flush sleep → re-check pool.query suspends
        await Promise.resolve(); // flush pool.query → fresh detected → return

        await prefillPromise;

        const pollCalls = mqttClient.publish.mock.calls.filter(([, m]) => {
            const dl = JSON.parse(m).DevEUI_downlink;
            return dl.FPort === 22 && dl.payload_hex === '0200';
        });
        // Only 1 config request should have been sent (stopped early)
        expect(pollCalls).toHaveLength(1);

        fuotaManager.activeSessions.delete(DEV);
    });

    // -----------------------------------------------------------------------
    // resolveIntervalLimits — band-specific clamping bounds
    // -----------------------------------------------------------------------

    describe('resolveIntervalLimits', () => {
        const UNIFIED    = { min: 5000,  max: 180000 };
        const TPM_EU868  = { min: 60000, max: 180000 };

        it('returns unified limits when ismBand is US915', () => {
            expect(fuotaManager.resolveIntervalLimits('US915', 'fw.bin')).toEqual(UNIFIED);
        });

        it('returns unified limits when ismBand is EU868 with non-TPM firmware', () => {
            expect(fuotaManager.resolveIntervalLimits('EU868', 'fw.bin')).toEqual(UNIFIED);
        });

        it('infers limits from 915 firmware filename when ismBand is absent', () => {
            expect(fuotaManager.resolveIntervalLimits('', 'TPMfw_2-35_Upgrade_Common_915.bin'))
                .toEqual(UNIFIED);
        });

        it('returns TPM_EU868 limits (60–180 s) for TPM EU868 firmware name, no ismBand', () => {
            expect(fuotaManager.resolveIntervalLimits(null, 'TPMfw_2-35_Upgrade_Common_868.bin'))
                .toEqual(TPM_EU868);
        });

        it('returns TPM_EU868 limits when ismBand=EU868 AND firmware is TPM', () => {
            expect(fuotaManager.resolveIntervalLimits('EU868', 'TPMfw_2-35_Upgrade_Common_868.bin'))
                .toEqual(TPM_EU868);
        });

        it('returns unified limits for VSM EU868 (not TPM)', () => {
            expect(fuotaManager.resolveIntervalLimits('EU868', 'VSMfw_1-27Upgrade_Common.bin'))
                .toEqual(UNIFIED);
        });

        it('returns unified limits for unknown band and universal firmware', () => {
            expect(fuotaManager.resolveIntervalLimits('', 'VSMfw_1-27Upgrade_Common.bin'))
                .toEqual(UNIFIED);
        });

        it('ismBand takes precedence over firmware filename', () => {
            expect(fuotaManager.resolveIntervalLimits('US915', 'VSMfw_1-27Upgrade_Common.bin'))
                .toEqual(UNIFIED);
        });
    });

    // -----------------------------------------------------------------------
    // isClassAOnly — Class A mode flag for EU868 TPM firmware
    // -----------------------------------------------------------------------

    describe('isClassAOnly', () => {
        it('returns true for TPM EU868 via firmware filename alone', () => {
            expect(fuotaManager.isClassAOnly('TPMfw_2-35_Upgrade_Common_868.bin', null)).toBe(true);
        });

        it('returns true for TPM firmware when ismBand is EU868', () => {
            expect(fuotaManager.isClassAOnly('TPMfw_2-35.bin', 'EU868')).toBe(true);
        });

        it('returns false for TPM US915 (not EU868)', () => {
            expect(fuotaManager.isClassAOnly('TPMfw_2-35_Upgrade_Common_915.bin', 'US915')).toBe(false);
        });

        it('returns false for VSM EU868 (not TPM)', () => {
            expect(fuotaManager.isClassAOnly('VSMfw_1-27Upgrade_Common.bin', 'EU868')).toBe(false);
        });

        it('returns false for non-TPM firmware with EU868 in name', () => {
            expect(fuotaManager.isClassAOnly('fw_868.bin', null)).toBe(false);
        });

        it('returns false when no firmware name and no ismBand', () => {
            expect(fuotaManager.isClassAOnly(null, null)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // startSession — Class A only path for EU868 TPM firmware
    // -----------------------------------------------------------------------

    describe('startSession Class A only (EU868 TPM)', () => {
        beforeEach(() => { fuotaManager.io = mockIo; });
        afterEach(() => { fuotaManager.io = null; });

        it('skips Class C switch for EU868 TPM firmware and sets classAOnly=true', async () => {
            const DEV = 'DEAD000000000060';
            const { sessionId } = fuotaManager.storeFirmware(
                'TPMfw_2-35_Upgrade_Common_868.bin', Buffer.alloc(49)
            );
            const freshTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const networkClient = require('../src/services/networkServerClient');
            const switchSpy = jest.spyOn(networkClient, 'switchToClassC');

            pool.query
                .mockResolvedValueOnce({ rows: [], rowCount: 0 })           // upsert device
                .mockResolvedValueOnce({ rows: [{ id: 'uuid-60' }] })       // session INSERT
                .mockResolvedValueOnce({ rows: [], rowCount: 1 })           // firmware_data UPDATE
                .mockResolvedValueOnce({ rows: [{ config_updated_at: freshTime }] }); // _prefillConfig fresh

            await fuotaManager.startSession(sessionId, DEV, 60000, 'EU868');

            expect(switchSpy).not.toHaveBeenCalled();
            const session = fuotaManager.activeSessions.get(DEV);
            expect(session?.classAOnly).toBe(true);
            expect(session?.classCConfigured).toBe(false);

            switchSpy.mockRestore();
            const s = fuotaManager.activeSessions.get(DEV);
            if (s) { fuotaManager._clearTimeouts(s); fuotaManager.activeSessions.delete(DEV); }
        });

        it('still calls Class C switch for US915 TPM firmware', async () => {
            const DEV = 'DEAD000000000061';
            const { sessionId } = fuotaManager.storeFirmware(
                'TPMfw_2-35_Upgrade_Common_915.bin', Buffer.alloc(49)
            );
            const freshTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const networkClient = require('../src/services/networkServerClient');
            const switchSpy = jest.spyOn(networkClient, 'switchToClassC').mockResolvedValue(null);

            pool.query
                .mockResolvedValueOnce({ rows: [], rowCount: 0 })
                .mockResolvedValueOnce({ rows: [{ id: 'uuid-61' }] })
                .mockResolvedValueOnce({ rows: [], rowCount: 1 })
                .mockResolvedValueOnce({ rows: [{ config_updated_at: freshTime }] }) // _prefillConfig fresh
                .mockResolvedValueOnce({ rows: [] });                                // resolveClassCProfile

            await fuotaManager.startSession(sessionId, DEV, 10000, 'US915');

            expect(switchSpy).toHaveBeenCalled();
            const session = fuotaManager.activeSessions.get(DEV);
            expect(session?.classAOnly).toBe(false);

            switchSpy.mockRestore();
            const s = fuotaManager.activeSessions.get(DEV);
            if (s) { fuotaManager._clearTimeouts(s); fuotaManager.activeSessions.delete(DEV); }
        });
    });

    // -----------------------------------------------------------------------
    // Early 0x10 ACK — received while session is still 'initializing'
    // -----------------------------------------------------------------------

    describe('early 0x10 ACK during initializing state', () => {
        beforeEach(() => { fuotaManager.io = mockIo; });
        afterEach(() => { fuotaManager.io = null; });

        /** Build a session in 'initializing' state, as startSession leaves it
         *  just after adding it to activeSessions and before _sendInitDownlink. */
        function makeInitializingSession(devEui) {
            return {
                devEui,
                dbId: null,
                state: 'initializing',
                firmwareName: 'fw.bin',
                firmwareSize: 49,
                blocks: [Buffer.alloc(49, 0xab)],
                totalBlocks: 1,
                blockIntervalMs: 5000,
                blocksSent: 0,
                blocksSentAtStart: 0,
                blocksResentSoFar: 0,
                confirmedBlocks: new Set(),
                configPollAttempt: 0,
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
            };
        }

        it('stashes a 0x10 ACK that arrives while state is initializing', () => {
            const devEui = 'EAEA000000000001';
            const session = makeInitializingSession(devEui);
            fuotaManager.activeSessions.set(devEui, session);

            fuotaManager.processPacket(
                `mqtt/things/${devEui}/uplink`,
                Buffer.from([0x10, 0x00]),
            );

            expect(session._earlyInitAck).toBeDefined();
            expect(session._earlyInitAck[0]).toBe(0x10);
            expect(session.state).toBe('initializing'); // not changed
        });

        it('stashes a 0x10 ACK that arrives while state is config_poll', () => {
            const devEui = 'EAEA000000000002';
            const session = makeInitializingSession(devEui);
            session.state = 'config_poll';
            fuotaManager.activeSessions.set(devEui, session);

            fuotaManager.processPacket(
                `mqtt/things/${devEui}/uplink`,
                Buffer.from([0x10, 0x00]),
            );

            expect(session._earlyInitAck).toBeDefined();
            expect(session.state).toBe('config_poll'); // not changed
        });

        it('consumes a stashed ACK in _sendInitDownlink — no init downlink sent, block sending starts', async () => {
            const devEui = 'EAEA000000000003';
            const session = makeInitializingSession(devEui);
            // Pre-stash the early ACK (as processPacket would have stored it)
            session._earlyInitAck = Buffer.from([0x10, 0x00]);
            fuotaManager.activeSessions.set(devEui, session);

            // _sendInitDownlink should detect the stash, skip the MQTT send, and
            // call _handleInitAck internally to kick off block sending
            fuotaManager._sendInitDownlink(session);

            // Stash must be consumed
            expect(session._earlyInitAck).toBeNull();

            // No FPort-22 init downlink (0x05…) must have been published
            const initDownlinks = mqttClient.publish.mock.calls.filter(([, msg]) => {
                try {
                    const p = JSON.parse(msg);
                    return p.DevEUI_downlink?.FPort === 22 &&
                           p.DevEUI_downlink?.payload_hex?.startsWith('05');
                } catch { return false; }
            });
            expect(initDownlinks).toHaveLength(0);

            // Drain microtasks so _sendAllBlocks publishes the first block
            await Promise.resolve();
            await Promise.resolve();

            // At least one FPort-25 block downlink must have been published
            const blockDownlinks = mqttClient.publish.mock.calls.filter(([, msg]) => {
                try { return JSON.parse(msg).DevEUI_downlink?.FPort === 25; }
                catch { return false; }
            });
            expect(blockDownlinks.length).toBeGreaterThan(0);
        });

        it('ignores a 0x10 ACK that arrives when there is no active session', () => {
            fuotaManager.processPacket('EAEA000000000099', 'mqtt/things/EAEA000000000099/uplink', Buffer.from([0x10, 0x00]));
            expect(fuotaManager.activeSessions.has('EAEA000000000099')).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // Init downlink retry schedule
    // -----------------------------------------------------------------------

    describe('init downlink retry on ACK timeout', () => {
        beforeEach(() => { fuotaManager.io = mockIo; });
        afterEach(() => { fuotaManager.io = null; });

        /** Minimal session already in 'waiting_ack', simulating a just-sent init downlink. */
        function makeWaitingAckSession(devEui) {
            return {
                devEui,
                dbId: null,
                state: 'waiting_ack',
                firmwareName: 'fw.bin',
                firmwareSize: 49,
                blocks: [Buffer.alloc(49, 0xab)],
                totalBlocks: 1,
                blockIntervalMs: 5000,
                blocksSent: 0,
                blocksSentAtStart: 0,
                blocksResentSoFar: 0,
                confirmedBlocks: new Set(),
                configPollAttempt: 0,
                initAttempts: 0,
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
                _earlyInitAck: undefined,
                startedAt: Date.now(),
            };
        }

        function countInitDownlinks() {
            return mqttClient.publish.mock.calls.filter(([, msg]) => {
                try {
                    const p = JSON.parse(msg);
                    return p.DevEUI_downlink?.FPort === 22 &&
                           p.DevEUI_downlink?.payload_hex?.startsWith('05');
                } catch { return false; }
            }).length;
        }

        it('initAckWaitMs returns 1 min for attempts 1–5', () => {
            for (let i = 1; i <= 5; i++) {
                expect(fuotaManager.initAckWaitMs(i)).toBe(60_000);
            }
        });

        it('initAckWaitMs returns 5 min for attempts 6–10', () => {
            for (let i = 6; i <= 10; i++) {
                expect(fuotaManager.initAckWaitMs(i)).toBe(300_000);
            }
        });

        it('initAckWaitMs returns 10 min for attempts 11–13', () => {
            for (let i = 11; i <= 13; i++) {
                expect(fuotaManager.initAckWaitMs(i)).toBe(600_000);
            }
        });

        it('re-sends the init downlink after the 1-min first-tier timeout', async () => {
            const devEui = 'FBFB000000000001';
            const session = makeWaitingAckSession(devEui);
            fuotaManager.activeSessions.set(devEui, session);

            fuotaManager._sendInitDownlink(session);
            expect(session.initAttempts).toBe(1);
            expect(countInitDownlinks()).toBe(1);

            await jest.advanceTimersByTimeAsync(60_000);
            await Promise.resolve();

            expect(session.initAttempts).toBe(2);
            expect(countInitDownlinks()).toBe(2);
        });

        it('switches to the 5-min interval after the 5th attempt', async () => {
            const devEui = 'FBFB000000000002';
            const session = makeWaitingAckSession(devEui);
            session.initAttempts = 5; // 5 already sent; this call becomes attempt 6
            fuotaManager.activeSessions.set(devEui, session);

            fuotaManager._sendInitDownlink(session);
            expect(session.initAttempts).toBe(6);

            // 1 min must NOT trigger a retry (we're in the 5-min tier now)
            await jest.advanceTimersByTimeAsync(60_000);
            await Promise.resolve();
            expect(session.initAttempts).toBe(6);

            // Full 5-min wait does trigger the retry
            await jest.advanceTimersByTimeAsync(240_000); // 4 min more = 5 min total
            await Promise.resolve();
            expect(session.initAttempts).toBe(7);
        });

        it('switches to the 10-min interval after the 10th attempt', async () => {
            const devEui = 'FBFB000000000003';
            const session = makeWaitingAckSession(devEui);
            session.initAttempts = 10;
            fuotaManager.activeSessions.set(devEui, session);

            fuotaManager._sendInitDownlink(session);
            expect(session.initAttempts).toBe(11);

            // 5 min must NOT trigger a retry
            await jest.advanceTimersByTimeAsync(300_000);
            await Promise.resolve();
            expect(session.initAttempts).toBe(11);

            // Full 10-min wait does trigger the retry
            await jest.advanceTimersByTimeAsync(300_000); // 5 min more = 10 min total
            await Promise.resolve();
            expect(session.initAttempts).toBe(12);
        });

        it('fails the session after all 13 attempts are exhausted', async () => {
            const devEui = 'FBFB000000000004';
            const session = makeWaitingAckSession(devEui);
            session.initAttempts = 12; // 12 done; this call becomes attempt 13 (the last)
            fuotaManager.activeSessions.set(devEui, session);

            fuotaManager._sendInitDownlink(session);
            expect(session.initAttempts).toBe(13);

            await jest.advanceTimersByTimeAsync(600_000);
            await Promise.resolve();

            // Session must be removed and failed
            expect(fuotaManager.activeSessions.has(devEui)).toBe(false);
        });

        it('a 0x10 ACK received during the retry window clears the timeout and starts block sending', async () => {
            const devEui = 'FBFB000000000005';
            const session = makeWaitingAckSession(devEui);
            fuotaManager.activeSessions.set(devEui, session);

            fuotaManager._sendInitDownlink(session);
            expect(session.initAttempts).toBe(1);

            // ACK arrives before the 1-min timeout
            fuotaManager.processPacket(
                `mqtt/things/${devEui}/uplink`,
                Buffer.from([0x10, 0x00]),
            );

            // Advancing past the 1-min mark must NOT trigger another init send
            await jest.advanceTimersByTimeAsync(60_000);
            await Promise.resolve();
            expect(session.initAttempts).toBe(1); // no retry

            // Block sending should have started
            await Promise.resolve();
            await Promise.resolve();
            const blockDownlinks = mqttClient.publish.mock.calls.filter(([, msg]) => {
                try { return JSON.parse(msg).DevEUI_downlink?.FPort === 25; }
                catch { return false; }
            });
            expect(blockDownlinks.length).toBeGreaterThan(0);
        });
    });
});

// ---------------------------------------------------------------------------
// 0x12 Upgrade Status (flash-write result)
// ---------------------------------------------------------------------------

describe('FUOTAManager 0x12 Upgrade Status handling', () => {
    // Default flash timeout (20 min) — must match FUOTA_FLASH_TIMEOUT_MS default in FUOTAManager.js
    const FLASH_TIMEOUT_MS = parseInt(process.env.FUOTA_FLASH_TIMEOUT_MS) || 20 * 60 * 1000;

    beforeEach(() => { fuotaManager.io = mockIo; });
    afterEach(() => { fuotaManager.io = null; });

    /** Build a session that has just received an empty 0x11 and is now in 'flashing'. */
    function makeFlashingSession(devEui) {
        return {
            ...makeVerifySession(devEui, 'flashing', 1),
            _flashTimeout: null,
        };
    }

    it('empty 0x11 (all blocks received) transitions to flashing, NOT complete', () => {
        const DEV = 'FC00000000000001';
        fuotaManager.activeSessions.set(DEV, makeVerifySession(DEV, 'verifying', 1));

        // 0x11 with missedFlag=0 and count=0 → all blocks received
        const emptyVerify = Buffer.from([0x11, 0x00, 0x00]);
        fuotaManager.processPacket(`mqtt/things/${DEV}/uplink`,
            JSON.stringify({ DevEUI_uplink: { payload_hex: emptyVerify.toString('hex') } }));

        const s = fuotaManager.activeSessions.get(DEV);
        // Session must still be active in 'flashing' state, not removed
        expect(s).toBeDefined();
        expect(s.state).toBe('flashing');

        // Cleanup
        if (s) { fuotaManager._clearTimeouts(s); fuotaManager.activeSessions.delete(DEV); }
    });

    it('0x12 with status=0 (success) calls _completeSession and removes the session', async () => {
        const DEV = 'FC00000000000002';
        fuotaManager.activeSessions.set(DEV, makeFlashingSession(DEV));

        const upgradeSuccess = Buffer.from([0x12, 0x00]);
        fuotaManager.processPacket(`mqtt/things/${DEV}/uplink`,
            JSON.stringify({ DevEUI_uplink: { payload_hex: upgradeSuccess.toString('hex') } }));

        // _completeSession is async — flush microtask queue
        await Promise.resolve();
        await Promise.resolve();

        // Session should be removed (complete)
        expect(fuotaManager.activeSessions.has(DEV)).toBe(false);

        // Progress emit should have state='complete'
        const progressEmits = mockIo.emit.mock.calls
            .filter(([ev]) => ev === 'fuota:progress')
            .map(([, p]) => p);
        expect(progressEmits.some(p => p.devEui === DEV && p.state === 'complete')).toBe(true);
    });

    it('0x12 with non-zero status code fails the session', async () => {
        const DEV = 'FC00000000000003';
        fuotaManager.activeSessions.set(DEV, makeFlashingSession(DEV));

        const upgradeFail = Buffer.from([0x12, 0x02]); // status=2 → failure
        fuotaManager.processPacket(`mqtt/things/${DEV}/uplink`,
            JSON.stringify({ DevEUI_uplink: { payload_hex: upgradeFail.toString('hex') } }));

        await Promise.resolve();
        await Promise.resolve();

        // Session should be removed (failed)
        expect(fuotaManager.activeSessions.has(DEV)).toBe(false);

        const progressEmits = mockIo.emit.mock.calls
            .filter(([ev]) => ev === 'fuota:progress')
            .map(([, p]) => p);
        expect(progressEmits.some(p => p.devEui === DEV && p.state === 'failed')).toBe(true);
    });

    it('flash timeout fails the session when no 0x12 arrives', async () => {
        const DEV = 'FC00000000000004';
        fuotaManager.activeSessions.set(DEV, makeFlashingSession(DEV));

        // Manually trigger the flash wait (simulates _handleVerifyUplink starting the timer)
        fuotaManager._startFlashTimeout(DEV);

        // Before timeout — session still active
        expect(fuotaManager.activeSessions.has(DEV)).toBe(true);

        // Advance past flash timeout
        await jest.advanceTimersByTimeAsync(FLASH_TIMEOUT_MS);
        await Promise.resolve();
        await Promise.resolve();

        // Session should be failed
        expect(fuotaManager.activeSessions.has(DEV)).toBe(false);
        const progressEmits = mockIo.emit.mock.calls
            .filter(([ev]) => ev === 'fuota:progress')
            .map(([, p]) => p);
        expect(progressEmits.some(p => p.devEui === DEV && p.state === 'failed')).toBe(true);
    });

    it('0x12 received while NOT in flashing state is ignored', () => {
        const DEV = 'FC00000000000005';
        fuotaManager.activeSessions.set(DEV, makeVerifySession(DEV, 'verifying', 1));

        const upgradeSuccess = Buffer.from([0x12, 0x00]);
        fuotaManager.processPacket(`mqtt/things/${DEV}/uplink`,
            JSON.stringify({ DevEUI_uplink: { payload_hex: upgradeSuccess.toString('hex') } }));

        // Session should remain in 'verifying' — 0x12 ignored when not flashing
        const s = fuotaManager.activeSessions.get(DEV);
        expect(s).toBeDefined();
        expect(s.state).toBe('verifying');

        fuotaManager.activeSessions.delete(DEV);
    });
});

// ---------------------------------------------------------------------------
// updateBlockInterval — live session block-interval override
// ---------------------------------------------------------------------------

describe('FUOTAManager updateBlockInterval', () => {
    it('updates blockIntervalMs on an active session and returns true', () => {
        const devEui = 'DEAD000000000099';
        const session = { devEui, state: 'sending_blocks', blockIntervalMs: 60000 };
        fuotaManager.activeSessions.set(devEui, session);

        const result = fuotaManager.updateBlockInterval(devEui, 5000);

        expect(result).toBe(true);
        expect(session.blockIntervalMs).toBe(5000);

        fuotaManager.activeSessions.delete(devEui);
    });

    it('returns false when no active session exists for the devEui', () => {
        expect(fuotaManager.updateBlockInterval('DEAD000000000099', 5000)).toBe(false);
    });
});
