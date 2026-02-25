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
