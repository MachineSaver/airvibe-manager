/**
 * Deinterleave raw hex waveform data into per-axis int16 sample arrays.
 *
 * @param {string} rawHex - Hex-encoded waveform payload (data bytes only)
 * @param {number} axisMask - Bitmask: 0x01=axis1, 0x02=axis2, 0x04=axis3, 0x07=tri-axis
 * @returns {{ axis1: number[], axis2: number[], axis3: number[], isAxis1: boolean, isAxis2: boolean, isAxis3: boolean }}
 */
function deinterleaveWaveform(rawHex, axisMask) {
    const buf = Buffer.from(rawHex, 'hex');
    const isTri = axisMask === 0x07;
    const isAxis1 = (axisMask & 0x01) !== 0;
    const isAxis2 = (axisMask & 0x02) !== 0;
    const isAxis3 = (axisMask & 0x04) !== 0;

    const axis1 = [], axis2 = [], axis3 = [];
    let offset = 0;
    while (offset < buf.length) {
        if (isTri) {
            if (offset + 6 > buf.length) break;
            axis1.push(buf.readInt16LE(offset));
            axis2.push(buf.readInt16LE(offset + 2));
            axis3.push(buf.readInt16LE(offset + 4));
            offset += 6;
        } else {
            if (offset + 2 > buf.length) break;
            const val = buf.readInt16LE(offset);
            if (isAxis1) axis1.push(val);
            else if (isAxis2) axis2.push(val);
            else if (isAxis3) axis3.push(val);
            offset += 2;
        }
    }
    return { axis1, axis2, axis3, isAxis1, isAxis2, isAxis3 };
}

module.exports = { deinterleaveWaveform };
