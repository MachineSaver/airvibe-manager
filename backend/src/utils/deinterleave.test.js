const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { deinterleaveWaveform } = require('./deinterleave');

describe('deinterleaveWaveform', () => {
    it('tri-axis 0x07: splits interleaved samples into three axes', () => {
        // 12 bytes = 2 tri-axis samples (6 bytes each)
        // Group 0: int16LE at 0,2,4 → 0x0006=6, 0x02a6=678, 0x0009=9
        // Group 1: int16LE at 6,8,10 → 0x0009=9, 0x0244=580, 0x0007=7
        const hex = '0600a6020900090044020700';
        const result = deinterleaveWaveform(hex, 0x07);
        assert.deepStrictEqual(result.axis1, [6, 9]);
        assert.deepStrictEqual(result.axis2, [678, 580]);
        assert.deepStrictEqual(result.axis3, [9, 7]);
        assert.strictEqual(result.isAxis1, true);
        assert.strictEqual(result.isAxis2, true);
        assert.strictEqual(result.isAxis3, true);
    });

    it('single axis 0x01: all values go to axis1', () => {
        const hex = '0600a60209000900';
        const result = deinterleaveWaveform(hex, 0x01);
        assert.deepStrictEqual(result.axis1, [6, 678, 9, 9]);
        assert.deepStrictEqual(result.axis2, []);
        assert.deepStrictEqual(result.axis3, []);
    });

    it('single axis 0x02: all values go to axis2', () => {
        const hex = '0600a602';
        const result = deinterleaveWaveform(hex, 0x02);
        assert.deepStrictEqual(result.axis1, []);
        assert.deepStrictEqual(result.axis2, [6, 678]);
        assert.deepStrictEqual(result.axis3, []);
    });

    it('single axis 0x04: all values go to axis3', () => {
        const hex = '0600a602';
        const result = deinterleaveWaveform(hex, 0x04);
        assert.deepStrictEqual(result.axis1, []);
        assert.deepStrictEqual(result.axis2, []);
        assert.deepStrictEqual(result.axis3, [6, 678]);
    });

    it('truncation: 5 bytes with tri-axis yields 0 samples (needs 6)', () => {
        const hex = '0600a60209';
        const result = deinterleaveWaveform(hex, 0x07);
        assert.deepStrictEqual(result.axis1, []);
        assert.deepStrictEqual(result.axis2, []);
        assert.deepStrictEqual(result.axis3, []);
    });

    it('empty input returns empty arrays', () => {
        const result = deinterleaveWaveform('', 0x07);
        assert.deepStrictEqual(result.axis1, []);
        assert.deepStrictEqual(result.axis2, []);
        assert.deepStrictEqual(result.axis3, []);
    });
});
