'use strict';

const adapter = require('../src/adapters/chirpstack');
const thingpark = require('../src/adapters/thingpark');

// ---------------------------------------------------------------------------
// normalizeIncoming — ChirpStack uplink → internal format
// ---------------------------------------------------------------------------

describe('normalizeIncoming — ChirpStack uplink', () => {
    const topic = 'application/1/device/0102030405060708/event/up';

    function makeMsg(overrides = {}) {
        return Buffer.from(JSON.stringify({
            deviceInfo: { devEui: '0102030405060708' },
            fPort: 5,
            fCnt: 42,
            data: Buffer.from('deadbeef', 'hex').toString('base64'),
            rxInfo: [{ rssi: -80, snr: 7.5 }],
            time: '2024-01-01T00:00:00Z',
            ...overrides,
        }));
    }

    it('rewrites topic to internal format', () => {
        const { topic: out } = adapter.normalizeIncoming(topic, makeMsg());
        expect(out).toBe('mqtt/things/0102030405060708/uplink');
    });

    it('converts base64 payload to hex', () => {
        const { message } = adapter.normalizeIncoming(topic, makeMsg());
        const body = JSON.parse(message.toString());
        expect(body.DevEUI_uplink.payload_hex).toBe('deadbeef');
    });

    it('uppercases DevEUI', () => {
        const { message } = adapter.normalizeIncoming(topic, makeMsg());
        const body = JSON.parse(message.toString());
        expect(body.DevEUI_uplink.DevEUI).toBe('0102030405060708');
    });

    it('copies fPort, fCnt, rssi, snr, time', () => {
        const { message } = adapter.normalizeIncoming(topic, makeMsg());
        const ul = JSON.parse(message.toString()).DevEUI_uplink;
        expect(ul.FPort).toBe(5);
        expect(ul.FCntUp).toBe(42);
        expect(ul.LrrRSSI).toBe(-80);
        expect(ul.LrrSNR).toBe(7.5);
        expect(ul.Time).toBe('2024-01-01T00:00:00Z');
    });

    it('handles missing data field (empty payload_hex)', () => {
        const msg = makeMsg({ data: undefined });
        const { message } = adapter.normalizeIncoming(topic, msg);
        const ul = JSON.parse(message.toString()).DevEUI_uplink;
        expect(ul.payload_hex).toBe('');
    });

    it('handles missing rxInfo gracefully (defaults to 0)', () => {
        const msg = makeMsg({ rxInfo: undefined });
        const { message } = adapter.normalizeIncoming(topic, msg);
        const ul = JSON.parse(message.toString()).DevEUI_uplink;
        expect(ul.LrrRSSI).toBe(0);
        expect(ul.LrrSNR).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// normalizeIncoming — ChirpStack downlink command echo → internal format
// ---------------------------------------------------------------------------

describe('normalizeIncoming — ChirpStack downlink echo', () => {
    const topic = 'application/1/device/aabbccddeeff0011/command/down';

    it('rewrites command/down to internal downlink topic', () => {
        const msg = Buffer.from(JSON.stringify({
            devEui: 'aabbccddeeff0011',
            fPort: 20,
            confirmed: false,
            data: Buffer.from('0319', 'hex').toString('base64'),
        }));
        const { topic: out, message } = adapter.normalizeIncoming(topic, msg);
        expect(out).toBe('mqtt/things/AABBCCDDEEFF0011/downlink');
        const dl = JSON.parse(message.toString()).DevEUI_downlink;
        expect(dl.FPort).toBe(20);
        expect(dl.payload_hex).toBe('0319');
    });
});

// ---------------------------------------------------------------------------
// normalizeIncoming — non-ChirpStack topics pass through unchanged
// ---------------------------------------------------------------------------

describe('normalizeIncoming — pass-through topics', () => {
    const cases = [
        'eu868/gateway/abc123/event/stats',
        'eu868/gateway/abc123/event/up',
        'application/1/device/abc/event/join',
        'application/1/device/abc/event/txack',
        'some/random/topic',
    ];

    it.each(cases)('passes through %s unchanged', (topic) => {
        const msg = Buffer.from('{"some":"data"}');
        const { topic: outTopic, message: outMsg } = adapter.normalizeIncoming(topic, msg);
        expect(outTopic).toBe(topic);
        expect(outMsg).toBe(msg);
    });
});

// ---------------------------------------------------------------------------
// normalizeIncoming — malformed JSON does not throw
// ---------------------------------------------------------------------------

describe('normalizeIncoming — malformed payload', () => {
    it('returns original topic+message on malformed uplink JSON', () => {
        const topic = 'application/1/device/0102030405060708/event/up';
        const msg = Buffer.from('not valid json {{{');
        const result = adapter.normalizeIncoming(topic, msg);
        expect(result.topic).toBe(topic);
        expect(result.message).toBe(msg);
    });
});

// ---------------------------------------------------------------------------
// normalizeOutgoing — internal downlink → ChirpStack command format
// ---------------------------------------------------------------------------

describe('normalizeOutgoing — internal downlink', () => {
    beforeEach(() => {
        process.env.CHIRPSTACK_APPLICATION_ID = '2';
    });

    afterEach(() => {
        delete process.env.CHIRPSTACK_APPLICATION_ID;
    });

    it('rewrites internal downlink topic to ChirpStack command/down', () => {
        const topic = 'mqtt/things/AABBCCDDEEFF0011/downlink';
        const msg = JSON.stringify({
            DevEUI_downlink: { DevEUI: 'AABBCCDDEEFF0011', FPort: 20, payload_hex: 'deadbeef' },
        });
        const { topic: out } = adapter.normalizeOutgoing(topic, msg);
        expect(out).toBe('application/2/device/aabbccddeeff0011/command/down');
    });

    it('converts hex payload to base64 in ChirpStack format', () => {
        const topic = 'mqtt/things/AABBCCDDEEFF0011/downlink';
        const msg = JSON.stringify({
            DevEUI_downlink: { DevEUI: 'AABBCCDDEEFF0011', FPort: 20, payload_hex: 'deadbeef' },
        });
        const { message } = adapter.normalizeOutgoing(topic, msg);
        const parsed = JSON.parse(message);
        expect(parsed.data).toBe(Buffer.from('deadbeef', 'hex').toString('base64'));
        expect(parsed.fPort).toBe(20);
        expect(parsed.confirmed).toBe(false);
    });

    it('uses default application ID 1 when env var not set', () => {
        delete process.env.CHIRPSTACK_APPLICATION_ID;
        const topic = 'mqtt/things/0000000000000001/downlink';
        const msg = JSON.stringify({
            DevEUI_downlink: { DevEUI: '0000000000000001', FPort: 5, payload_hex: 'ff' },
        });
        const { topic: out } = adapter.normalizeOutgoing(topic, msg);
        expect(out).toBe('application/1/device/0000000000000001/command/down');
    });

    it('passes non-downlink topics through unchanged', () => {
        const topic = 'mqtt/things/AABBCCDDEEFF0011/uplink';
        const msg = '{"DevEUI_uplink":{}}';
        const result = adapter.normalizeOutgoing(topic, msg);
        expect(result.topic).toBe(topic);
        expect(result.message).toBe(msg);
    });
});

// ---------------------------------------------------------------------------
// ThingPark adapter — identity passthrough (both directions)
// ---------------------------------------------------------------------------

describe('thingpark adapter — normalizeIncoming passthrough', () => {
    const cases = [
        ['mqtt/things/0102030405060708/uplink',   '{"DevEUI_uplink":{"DevEUI":"0102030405060708","payload_hex":"deadbeef"}}'],
        ['mqtt/things/AABBCCDDEEFF0011/uplink',   '{"DevEUI_uplink":{"payload_hex":"0319"}}'],
        ['application/1/device/abc/event/up',     '{"data":"base64stuff"}'],
        ['some/arbitrary/topic',                  'raw bytes'],
        ['eu868/gateway/abc/event/stats',         '{}'],
    ];

    it.each(cases)('returns topic and message byte-for-byte for %s', (topic, payload) => {
        const msg = Buffer.from(payload);
        const { topic: outTopic, message: outMsg } = thingpark.normalizeIncoming(topic, msg);
        expect(outTopic).toBe(topic);
        expect(outMsg).toBe(msg);
    });
});

describe('thingpark adapter — normalizeOutgoing passthrough', () => {
    const cases = [
        ['mqtt/things/0102030405060708/downlink',  '{"DevEUI_downlink":{"FPort":20,"payload_hex":"deadbeef"}}'],
        ['mqtt/things/AABBCCDDEEFF0011/downlink',  '{"DevEUI_downlink":{"FPort":8,"payload_hex":"0319"}}'],
        ['mqtt/things/0102030405060708/uplink',    '{"DevEUI_uplink":{}}'],
        ['some/arbitrary/topic',                   'raw bytes'],
    ];

    it.each(cases)('returns topic and message byte-for-byte for %s', (topic, payload) => {
        const { topic: outTopic, message: outMsg } = thingpark.normalizeOutgoing(topic, payload);
        expect(outTopic).toBe(topic);
        expect(outMsg).toBe(payload);
    });
});
