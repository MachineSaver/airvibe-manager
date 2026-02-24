'use strict';

// ---------------------------------------------------------------------------
// Mock all external dependencies before any require() calls.
// Jest hoists jest.mock() calls above imports automatically.
// ---------------------------------------------------------------------------

jest.mock('../src/db', () => ({
    pool: { query: jest.fn() },
}));

jest.mock('../src/codec/AirVibe_TS013_Codec', () => ({
    decodeUplink: jest.fn(),
    encodeDownlink: jest.fn(),
}));

jest.mock('../src/services/AuditLogger', () => ({
    log: jest.fn(),
}));

jest.mock('../src/mqttClient', () => ({
    publish: jest.fn(),
}));

// Prevent setInterval callbacks from firing during tests
jest.useFakeTimers();

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

const { pool } = require('../src/db');
const codec = require('../src/codec/AirVibe_TS013_Codec');
const mqttClient = require('../src/mqttClient');
const waveformManager = require('../src/services/WaveformManager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an internal-format uplink message Buffer for a given hex payload.
 */
function makeUplinkMsg(payloadHex, devEui = '0102030405060708') {
    return Buffer.from(JSON.stringify({
        DevEUI_uplink: {
            DevEUI: devEui,
            FPort: 8,
            FCntUp: 1,
            payload_hex: payloadHex,
        },
    }));
}

const DEVEUI = '0102030405060708';
const UPLINK_TOPIC = `mqtt/things/${DEVEUI}/uplink`;

beforeEach(() => {
    jest.clearAllMocks();
    // Reset the WaveformManager rate-limiter between tests. The singleton's
    // lastDownlinkTimes persists across tests; with fake timers Date.now() is
    // frozen so the 60-second prune window never expires, causing sendAutoDownlink
    // to be rate-limited from the second test onwards.
    waveformManager.lastDownlinkTimes.clear();
    // Quiet console noise in test output
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TWIU (0x03) — waveform header parsing
// ---------------------------------------------------------------------------

describe('processPacket — TWIU (0x03)', () => {
    beforeEach(() => {
        // Codec returns parsed TWIU metadata
        codec.decodeUplink.mockReturnValue({
            data: {
                packet_type: 3,
                transaction_id: 0x19,
                sampling_rate_hz: 20000,
                samples_per_axis: 512,
                axis_selection: 'axis_1_2_3',
                number_of_segments: 10,
                hw_filter: 'lp_2670_hz',
                error_code: 0,
            },
            errors: [],
        });
        codec.encodeDownlink.mockReturnValue({ bytes: [0x03, 0x19] });
    });

    it('inserts a new waveform row with correct segment count and sample rate', async () => {
        // abortStalePendingWaveforms → no stale rows
        pool.query.mockResolvedValueOnce({ rows: [] });
        // findPendingWaveformId → no existing waveform
        pool.query.mockResolvedValueOnce({ rows: [] });
        // INSERT waveform → return new id
        pool.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });
        // encodeDownlink ACK bytes used by sendDownlink (no DB call)

        // 03 = TWIU, 19 = txId, rest is ignored (codec is mocked)
        const payloadHex = '0319' + '00'.repeat(10);
        await waveformManager.processPacket(UPLINK_TOPIC, makeUplinkMsg(payloadHex));

        // Third pool.query call is the INSERT
        const insertCall = pool.query.mock.calls[2];
        expect(insertCall[0]).toMatch(/INSERT INTO waveforms/i);
        // 'pending' is hardcoded in the SQL string, not a parameter
        expect(insertCall[1]).toEqual([DEVEUI, 0x19, 10, expect.objectContaining({
            sampleRate: 20000,
            numSegments: 10,
        })]);
    });

    it('sends a waveform_info_ack downlink after TWIU', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [] })   // abortStale
            .mockResolvedValueOnce({ rows: [] })   // findPending
            .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // INSERT

        codec.encodeDownlink.mockReturnValue({ bytes: [0x03, 0x19] });

        const payloadHex = '0319' + '00'.repeat(10);
        await waveformManager.processPacket(UPLINK_TOPIC, makeUplinkMsg(payloadHex));

        expect(codec.encodeDownlink).toHaveBeenCalledWith(expect.objectContaining({
            fPort: 20,
            data: expect.objectContaining({ opcode: 'waveform_info_ack' }),
        }));
        expect(mqttClient.publish).toHaveBeenCalledWith(
            `mqtt/things/${DEVEUI}/downlink`,
            expect.any(String),
        );
    });

    it('aborts existing pending waveform when a newer TxID arrives', async () => {
        // abortStalePendingWaveforms returns one stale waveform
        pool.query.mockResolvedValueOnce({ rows: [{ id: 7, transaction_id: 0x10 }] });
        // UPDATE abort
        pool.query.mockResolvedValueOnce({ rows: [] });
        // findPendingWaveformId → none
        pool.query.mockResolvedValueOnce({ rows: [] });
        // INSERT new waveform
        pool.query.mockResolvedValueOnce({ rows: [{ id: 8 }] });

        codec.encodeDownlink.mockReturnValue({ bytes: [0x03, 0x19] });

        const payloadHex = '0319' + '00'.repeat(10);
        await waveformManager.processPacket(UPLINK_TOPIC, makeUplinkMsg(payloadHex));

        const abortCall = pool.query.mock.calls[1];
        expect(abortCall[0]).toMatch(/UPDATE waveforms SET status = 'aborted'/i);
        expect(abortCall[1]).toEqual([7]);
    });
});

// ---------------------------------------------------------------------------
// TWD (0x01) — data segment storage
// ---------------------------------------------------------------------------

describe('processPacket — TWD (0x01)', () => {
    beforeEach(() => {
        codec.decodeUplink.mockReturnValue({
            data: {
                packet_type: 1,
                transaction_id: 0x19,
                segment_number: 3,
            },
            errors: [],
        });
    });

    it('inserts segment with correct index into the DB', async () => {
        // abortStale
        pool.query.mockResolvedValueOnce({ rows: [] });
        // findPendingWaveformId → existing waveform id=42
        pool.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });
        // INSERT segment (new)
        pool.query.mockResolvedValueOnce({ rows: [{ segment_index: 3 }], rowCount: 1 });
        // UPDATE received_segments_count
        pool.query.mockResolvedValueOnce({ rows: [] });
        // checkRepairBatchComplete → requested_segments empty
        pool.query.mockResolvedValueOnce({ rows: [{ requested_segments: [] }] });

        // 01 = TWD, 19 = txId, 04 bytes header, rest = sample data
        const payloadHex = '0119' + '0300' + 'a5b6c7d8'.repeat(4);
        await waveformManager.processPacket(UPLINK_TOPIC, makeUplinkMsg(payloadHex));

        const segInsert = pool.query.mock.calls[2];
        expect(segInsert[0]).toMatch(/INSERT INTO waveform_segments/i);
        // segment_index should be what codec returned (3)
        expect(segInsert[1][1]).toBe(3);
        // waveform_id should be 42
        expect(segInsert[1][0]).toBe(42);
    });

    it('creates a placeholder waveform row when no pending waveform exists', async () => {
        // abortStale
        pool.query.mockResolvedValueOnce({ rows: [] });
        // findPendingWaveformId → none
        pool.query.mockResolvedValueOnce({ rows: [] });
        // INSERT placeholder waveform
        pool.query.mockResolvedValueOnce({ rows: [{ id: 99 }] });
        // INSERT segment
        pool.query.mockResolvedValueOnce({ rows: [{ segment_index: 0 }], rowCount: 1 });
        // UPDATE received_segments_count
        pool.query.mockResolvedValueOnce({ rows: [] });
        // checkRepairBatchComplete
        pool.query.mockResolvedValueOnce({ rows: [{ requested_segments: [] }] });

        const payloadHex = '0119' + '0000' + 'ff'.repeat(8);
        await waveformManager.processPacket(UPLINK_TOPIC, makeUplinkMsg(payloadHex));

        const placeholderInsert = pool.query.mock.calls[2];
        expect(placeholderInsert[0]).toMatch(/INSERT INTO waveforms/i);
        // 'pending' is hardcoded in the SQL string, not a parameter
        expect(placeholderInsert[1]).toEqual([DEVEUI, 0x19]);
    });
});

// ---------------------------------------------------------------------------
// TWF (0x05) — final segment triggers assembly
// ---------------------------------------------------------------------------

describe('processPacket — TWF (0x05)', () => {
    beforeEach(() => {
        codec.decodeUplink.mockReturnValue({
            data: {
                packet_type: 5,
                transaction_id: 0x19,
                segment_number: 9,
            },
            errors: [],
        });
        codec.encodeDownlink.mockReturnValue({ bytes: [0x03, 0x19] });
    });

    it('assembles the waveform when all segments are present', async () => {
        // abortStale
        pool.query.mockResolvedValueOnce({ rows: [] });
        // findPendingWaveformId → id=42
        pool.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });
        // INSERT final segment
        pool.query.mockResolvedValueOnce({ rows: [{ segment_index: 9 }], rowCount: 1 });
        // UPDATE received_segments_count
        pool.query.mockResolvedValueOnce({ rows: [] });
        // checkCompletion: SELECT waveform metadata
        pool.query.mockResolvedValueOnce({
            rows: [{ expected_segments: 2, metadata: { numSegments: 2 } }],
        });
        // SELECT all segment indices (segments 0 and 1 both present — complete)
        pool.query.mockResolvedValueOnce({
            rows: [{ segment_index: 0 }, { segment_index: 1 }],
        });
        // assembleWaveform: SELECT segments in order
        pool.query.mockResolvedValueOnce({
            rows: [
                { data: Buffer.from('aabb', 'hex') },
                { data: Buffer.from('ccdd', 'hex') },
            ],
        });
        // assembleWaveform: UPDATE status='complete'
        pool.query.mockResolvedValueOnce({ rows: [] });

        const payloadHex = '0519' + '0900' + 'aa'.repeat(4);
        await waveformManager.processPacket(UPLINK_TOPIC, makeUplinkMsg(payloadHex));

        // The final UPDATE should set status = 'complete'
        const updateComplete = pool.query.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].includes("status = 'complete'")
        );
        expect(updateComplete).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// Missing segment detection (checkCompletion with gaps)
// ---------------------------------------------------------------------------

describe('checkCompletion — missing segments', () => {
    it('requests missing segments when gaps exist', async () => {
        codec.encodeDownlink.mockReturnValue({ bytes: [0x15, 0x01, 0x00, 0x01] });

        // SELECT waveform
        pool.query.mockResolvedValueOnce({
            rows: [{ expected_segments: 4, metadata: { numSegments: 4 } }],
        });
        // SELECT received segment indices (segments 0, 2, 3 present — 1 missing)
        pool.query.mockResolvedValueOnce({
            rows: [
                { segment_index: 0 },
                { segment_index: 2 },
                { segment_index: 3 },
            ],
        });
        // UPDATE requested_segments
        pool.query.mockResolvedValueOnce({ rows: [] });

        await waveformManager.checkCompletion(DEVEUI, 0x19, 1);

        // Should request segment 1 on fPort 21
        expect(codec.encodeDownlink).toHaveBeenCalledWith(expect.objectContaining({
            fPort: 21,
            data: expect.objectContaining({ segments: [1] }),
        }));
        expect(mqttClient.publish).toHaveBeenCalledWith(
            `mqtt/things/${DEVEUI}/downlink`,
            expect.any(String),
        );
    });

    it('does not request segments when TWIU metadata is missing', async () => {
        // SELECT waveform → no metadata yet
        pool.query.mockResolvedValueOnce({
            rows: [{ expected_segments: null, metadata: null }],
        });

        await waveformManager.checkCompletion(DEVEUI, 0x19, 1);

        // Should not attempt a segment request
        expect(codec.encodeDownlink).not.toHaveBeenCalled();
        expect(mqttClient.publish).not.toHaveBeenCalled();
    });

    it('generates missing segment list correctly across the full range', async () => {
        codec.encodeDownlink.mockReturnValue({ bytes: [0x01] });

        // 5 expected segments; only 0, 4 received → 1, 2, 3 missing
        pool.query.mockResolvedValueOnce({
            rows: [{ expected_segments: 5, metadata: { numSegments: 5 } }],
        });
        pool.query.mockResolvedValueOnce({
            rows: [{ segment_index: 0 }, { segment_index: 4 }],
        });
        pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE requested_segments

        await waveformManager.checkCompletion(DEVEUI, 0x05, 1);

        const encodeCall = codec.encodeDownlink.mock.calls[0];
        expect(encodeCall[0].data.segments).toEqual([1, 2, 3]);
    });
});
