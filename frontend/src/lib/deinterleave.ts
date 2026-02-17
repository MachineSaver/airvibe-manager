/**
 * Deinterleave raw hex waveform data into per-axis int16 sample arrays.
 * Browser-safe implementation using DataView instead of Node.js Buffer.
 */
export function deinterleaveWaveform(
  rawHex: string,
  axisMask: number
): { axis1: number[]; axis2: number[]; axis3: number[] } | null {
  if (!rawHex) return null;

  const bytes = new Uint8Array(rawHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(rawHex.substring(i * 2, i * 2 + 2), 16);
  }
  const view = new DataView(bytes.buffer);

  const isTri = axisMask === 0x07;
  const isAxis1 = (axisMask & 0x01) !== 0;
  const isAxis2 = (axisMask & 0x02) !== 0;
  const isAxis3 = (axisMask & 0x04) !== 0;

  const axis1: number[] = [];
  const axis2: number[] = [];
  const axis3: number[] = [];

  let offset = 0;
  while (offset < bytes.length) {
    if (isTri) {
      if (offset + 6 > bytes.length) break;
      axis1.push(view.getInt16(offset, true));
      axis2.push(view.getInt16(offset + 2, true));
      axis3.push(view.getInt16(offset + 4, true));
      offset += 6;
    } else {
      if (offset + 2 > bytes.length) break;
      const val = view.getInt16(offset, true);
      if (isAxis1) axis1.push(val);
      else if (isAxis2) axis2.push(val);
      else if (isAxis3) axis3.push(val);
      offset += 2;
    }
  }

  return { axis1, axis2, axis3 };
}
