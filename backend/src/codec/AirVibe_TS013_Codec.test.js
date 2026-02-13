const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decodeUplink, decodeDownlink, encodeDownlink } = require('./AirVibe_TS013_Codec');

function hexToBytes(hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
}

describe('Codec — uplink decoding', () => {
    it('decodes TWIU (type 0x03) waveform header', () => {
        // 03 19 0000 07 0a00 81 204e 4200 08
        const bytes = hexToBytes('03190000070a0081204e420008');
        const result = decodeUplink({ bytes, fPort: 8 });
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.data.packet_type, 3);
        assert.strictEqual(result.data.transaction_id, 0x19);
        assert.strictEqual(result.data.axis_selection, 'axis_1_2_3');
        assert.strictEqual(result.data.number_of_segments, 10);
        assert.strictEqual(result.data.sampling_rate_hz, 20000);
        assert.strictEqual(result.data.hw_filter, 'lp_2670_hz');
    });

    it('decodes TWD segment 0 (type 0x01) with correct samples', () => {
        const bytes = hexToBytes('011900000600a60209000900440207000700ca0103000600350101000700930005000500f1ffffff050050fff9ff');
        const result = decodeUplink({ bytes, fPort: 8 });
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.data.packet_type, 1);
        assert.strictEqual(result.data.transaction_id, 0x19);
        assert.strictEqual(result.data.segment_number, 0);
        assert.strictEqual(result.data.is_last_segment, false);
        // First three samples: 6, 678, 9
        assert.deepStrictEqual(result.data.samples_i16.slice(0, 3), [6, 678, 9]);
    });

    it('decodes TWF (type 0x05) as last segment', () => {
        const bytes = hexToBytes('05190900f4ffacff0300f9ff4e000200fcffee000800');
        const result = decodeUplink({ bytes, fPort: 8 });
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.data.packet_type, 5);
        assert.strictEqual(result.data.is_last_segment, true);
        assert.strictEqual(result.data.segment_number, 9);
    });
});

describe('Codec — downlink round-trips', () => {
    it('port 20: encode/decode ACK round-trip', () => {
        const input = {
            fPort: 20,
            data: { opcode: 'waveform_data_ack', transaction_id: 0x19 }
        };
        const encoded = encodeDownlink(input);
        assert.deepStrictEqual(encoded.errors, []);
        assert.strictEqual(encoded.fPort, 20);
        assert.deepStrictEqual(encoded.bytes, [0x01, 0x19]);

        const decoded = decodeDownlink({ bytes: encoded.bytes, fPort: 20 });
        assert.deepStrictEqual(decoded.errors, []);
        assert.strictEqual(decoded.data.opcode, 'waveform_data_ack');
        assert.strictEqual(decoded.data.transaction_id, 0x19);
    });

    it('port 21: encode/decode missing segments round-trip', () => {
        const input = {
            fPort: 21,
            data: { value_size_mode: 0, segments: [2, 5, 7] }
        };
        const encoded = encodeDownlink(input);
        assert.deepStrictEqual(encoded.errors, []);
        assert.deepStrictEqual(encoded.bytes, [0x00, 0x03, 0x02, 0x05, 0x07]);

        const decoded = decodeDownlink({ bytes: encoded.bytes, fPort: 21 });
        assert.deepStrictEqual(decoded.errors, []);
        assert.strictEqual(decoded.data.segment_count, 3);
        assert.deepStrictEqual(decoded.data.segments, [2, 5, 7]);
    });

    it('port 22: encode/decode command round-trip', () => {
        const input = {
            fPort: 22,
            data: { command_id: 'request_new_capture', parameters: [0x07] }
        };
        const encoded = encodeDownlink(input);
        assert.deepStrictEqual(encoded.errors, []);
        // command 0x0003 LE = [0x03, 0x00], then param 0x07
        assert.deepStrictEqual(encoded.bytes, [0x03, 0x00, 0x07]);

        const decoded = decodeDownlink({ bytes: encoded.bytes, fPort: 22 });
        assert.deepStrictEqual(decoded.errors, []);
        assert.strictEqual(decoded.data.command_id, 'request_new_capture');
        assert.deepStrictEqual(decoded.data.parameters, [0x07]);
    });
});
