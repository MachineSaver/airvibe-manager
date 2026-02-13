const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { WAVEFORM_PACKETS } = require('./DemoSimulator');

// Canonical packets from frontend/src/utils/waveformTracker.ts EXAMPLE_PACKETS
const CANONICAL = [
    '03190000070a0081204e420008',
    '011900000600a60209000900440207000700ca0103000600350101000700930005000500f1ffffff050050fff9ff',
    '011901000100b8fef7ff0000dbfdf6fffdff94fdf7ff02007afdfbff050089fdfaff0300b9fdf6fffeff11fef8ff',
    '01190200f9ff8afef9fff9ff19fffcfff4ffafff0100f3ff53000500fafff8001200ffff90010f00fcff8b020d00',
    '01190300fbffd3020c00fffff5020d00fcffed020d000000c502080005001202070008008d0100000d00eb000000',
    '0119040008004000030005009fff0000040002fffdff030076fef4ff010003fef2ff0500b1fdfaff090081fdfdff',
    '0119050008009afdf5ff0400e0fdf4ff000045fefafffaffc6fefefffbff5efffdfff8fffffffefff9ffa700fdff',
    '01190600ffff490101000000db010300ffffb6020100fefff10205000200040305000500e6020200ffffab020300',
    '011907000000cf0107000400cf01090007003f0105000300faffffff030057ff00000800c1fe000003003cfefdff',
    '011908000000d8fdf6ffffff98fdf7fffcff78fdfffffdff87fdf7fff9ff0ffefefff8ff85fefdfff4ff0eff0000',
    '05190900f4ffacff0300f9ff4e000200fcffee000800',
];

describe('DemoSimulator WAVEFORM_PACKETS parity', () => {
    it('has exactly 11 packets', () => {
        assert.strictEqual(WAVEFORM_PACKETS.length, 11);
    });

    for (let i = 0; i < CANONICAL.length; i++) {
        it(`packet ${i} matches canonical EXAMPLE_PACKETS`, () => {
            assert.strictEqual(WAVEFORM_PACKETS[i], CANONICAL[i]);
        });
    }
});
