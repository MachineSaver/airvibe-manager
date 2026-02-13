/**
 * Waveform Tracker — offline decode/assembly logic for AirVibe time-waveform packets.
 *
 * Decodes raw hex (Types 01, 03, 05 on fPort 8) using the same byte layout as
 * AirVibe_TS013_Codec_v2.1.2 (little-endian u16/i16).
 */

// ── Colours ──────────────────────────────────────────────────────────────────
export const COL = {
  axis1: '#3b82f6',
  axis2: '#10b981',
  axis3: '#f59e0b',
  green: '#22c55e',
  red: '#ef4444',
  yellow: '#eab308',
  grey: '#94a3b8',
} as const;

// ── Types ────────────────────────────────────────────────────────────────────
export interface Packet {
  PacketType: number;
  TransactionID: number;
  SegmentNumber: number;
  LastSegment: boolean;
  Samples: number[];
  _raw: Uint8Array;
}

export interface ParamsPacket extends Packet {
  AxisSelectionText: string;
  AxisMask: number;
  NumberOfSegments: number;
  SamplingRate_Hz: number;
  SamplesPerAxis: number;
  HwFilter: string;
  ErrorCode: number;
}

export interface Downlink {
  label: string;
  port: number;
  hex: string;
}

export interface Transaction {
  txId: number;
  axisMask: number;
  sr: number;
  expected: number | null;
  samplesPerAxis: number;
  params: ParamsPacket | null;
  segments: Map<number, Packet>;
  complete: boolean;
  lastSegSeen: boolean;
  downlinks: Downlink[];
  firstIngestTime: number | null;
}

export type WaveState = Record<number, Transaction>;

// ── Codec helpers (LE, matching TS013 v2.1.2) ────────────────────────────────
function hexToBytes(hex: string): number[] {
  const s = hex.replace(/\s|0x/gi, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substring(i, i + 2), 16));
  return out;
}

function u8(b: number[], i: number) { return b[i] & 0xff; }
function u16(b: number[], i: number) { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number) { const v = u16(b, i); return v & 0x8000 ? v - 0x10000 : v; }

const AXIS_LABELS: Record<number, string> = { 1: 'Axis 1', 2: 'Axis 2', 4: 'Axis 3', 7: 'Axes 1, 2, 3' };

const HW_FILTER_ID: Record<number, string> = {
  0: 'none', 23: 'hp_33_hz', 22: 'hp_67_hz', 21: 'hp_134_hz', 20: 'hp_267_hz',
  19: 'hp_593_hz', 18: 'hp_1335_hz', 17: 'hp_2670_hz', 135: 'lp_33_hz', 134: 'lp_67_hz',
  133: 'lp_134_hz', 132: 'lp_267_hz', 131: 'lp_593_hz', 130: 'lp_1335_hz', 129: 'lp_2670_hz',
  128: 'lp_6675_hz',
};

const STATE_COLORS: Record<string, string> = {
  green: COL.green,
  red: COL.red,
  yellow: COL.yellow,
  grey: COL.grey,
};

// ── Decode ───────────────────────────────────────────────────────────────────
export function decodePacket(hex: string): Packet {
  const b = hexToBytes(hex.trim());
  if (b.length < 4) throw new Error('Packet too short');

  const type = u8(b, 0);
  const txId = u8(b, 1);
  const raw = new Uint8Array(b);

  if (type === 0x03) {
    const axisMask = u8(b, 4);
    const p: ParamsPacket = {
      PacketType: 3,
      TransactionID: txId,
      SegmentNumber: u8(b, 2),
      LastSegment: false,
      Samples: [],
      _raw: raw,
      AxisSelectionText: AXIS_LABELS[axisMask] || `Unknown (0x${axisMask.toString(16)})`,
      AxisMask: axisMask,
      NumberOfSegments: u16(b, 5),
      SamplingRate_Hz: u16(b, 8),
      SamplesPerAxis: u16(b, 10),
      HwFilter: HW_FILTER_ID[u8(b, 7)] || 'unknown',
      ErrorCode: u8(b, 3),
    };
    return p;
  }

  if (type === 0x01 || type === 0x05) {
    const samples: number[] = [];
    for (let i = 4; i + 1 < b.length; i += 2) samples.push(i16(b, i));
    return {
      PacketType: type,
      TransactionID: txId,
      SegmentNumber: u16(b, 2),
      LastSegment: type === 0x05,
      Samples: samples,
      _raw: raw,
    };
  }

  throw new Error(`Unsupported packet type: 0x${type.toString(16)}`);
}

// ── Assemble ─────────────────────────────────────────────────────────────────
function computeDownlinks(tx: Transaction): Downlink[] {
  const dl: Downlink[] = [];
  const txHex = tx.txId.toString(16).padStart(2, '0');

  if (tx.params) {
    dl.push({ label: 'TWIU ACK', port: 20, hex: `03${txHex}` });
  }

  if (tx.complete) {
    dl.push({ label: 'Data ACK', port: 20, hex: `01${txHex}` });
  } else if (tx.lastSegSeen && tx.expected != null) {
    const missing: number[] = [];
    for (let i = 0; i < tx.expected; i++) {
      if (!tx.segments.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      const maxIdx = Math.max(...missing);
      const mode = maxIdx > 254 ? 1 : 0;
      const bytes = [mode, missing.length];
      for (const idx of missing) {
        if (mode === 0) bytes.push(idx & 0xff);
        else { bytes.push(idx & 0xff); bytes.push((idx >> 8) & 0xff); }
      }
      dl.push({
        label: `Request ${missing.length} missing`,
        port: 21,
        hex: bytes.map(v => v.toString(16).padStart(2, '0')).join(''),
      });
    }
  }

  if (!tx.params && tx.segments.size > 0) {
    dl.push({ label: 'Request TWIU', port: 22, hex: '0100' });
  }

  return dl;
}

export function assemble(state: WaveState, packet: Packet): WaveState {
  const txId = packet.TransactionID;
  const prev = state[txId];
  const tx: Transaction = prev
    ? { ...prev, segments: new Map(prev.segments) }
    : {
        txId,
        axisMask: 0,
        sr: 0,
        expected: null,
        samplesPerAxis: 0,
        params: null,
        segments: new Map(),
        complete: false,
        lastSegSeen: false,
        downlinks: [],
        firstIngestTime: null,
      };

  if (packet.PacketType === 0x03) {
    const pp = packet as ParamsPacket;
    tx.params = pp;
    tx.axisMask = pp.AxisMask;
    tx.sr = pp.SamplingRate_Hz;
    tx.expected = pp.NumberOfSegments;
    tx.samplesPerAxis = pp.SamplesPerAxis;
  } else {
    tx.segments.set(packet.SegmentNumber, packet);
    if (tx.firstIngestTime == null) tx.firstIngestTime = Date.now();
    if (packet.LastSegment) tx.lastSegSeen = true;
  }

  // Check completion
  if (tx.expected != null && tx.lastSegSeen) {
    let allPresent = true;
    for (let i = 0; i < tx.expected; i++) {
      if (!tx.segments.has(i)) { allPresent = false; break; }
    }
    tx.complete = allPresent;
  }

  tx.downlinks = computeDownlinks(tx);
  return { ...state, [txId]: tx };
}

// ── Segment states ───────────────────────────────────────────────────────────
export function segmentStates(tx: Transaction): string[] {
  if (tx.expected == null) return [];

  // Collect indices of segments that have been requested via downlink
  const requestedSet = new Set<number>();
  for (const dl of tx.downlinks) {
    if (dl.port === 21) {
      const bytes = hexToBytes(dl.hex);
      const mode = bytes[0];
      const count = bytes[1];
      let o = 2;
      for (let j = 0; j < count && o < bytes.length; j++) {
        if (mode === 0) { requestedSet.add(bytes[o]); o += 1; }
        else { requestedSet.add(u16(bytes, o)); o += 2; }
      }
    }
  }

  // Find the highest received segment index to detect gaps
  let maxReceived = -1;
  for (const idx of tx.segments.keys()) {
    if (idx > maxReceived) maxReceived = idx;
  }

  const out: string[] = [];
  for (let i = 0; i < tx.expected; i++) {
    if (tx.segments.has(i)) {
      out.push('green');
    } else if (requestedSet.has(i)) {
      out.push('yellow');
    } else if (i < maxReceived || tx.lastSegSeen) {
      // Gap: a higher-indexed segment was received but this one wasn't
      out.push('red');
    } else {
      out.push('grey');
    }
  }
  return out;
}

// ── Waveform plotting ────────────────────────────────────────────────────────
export function buildWaveformForPlot(tx: Transaction): {
  totalSamples: number;
  axis: [number[], number[], number[]];
  segRects: { i0: number; i1: number; color: string }[];
} | null {
  if (!tx.params || tx.segments.size === 0) return null;

  const isTri = tx.axisMask === 0x07;
  const div = isTri ? 3 : 1;
  const expected = tx.expected ?? 0;
  const states = segmentStates(tx);

  // Compute average raw samples per segment from received data
  let totalRawSamples = 0;
  for (const [, pkt] of tx.segments) totalRawSamples += pkt.Samples.length;
  const avgRawPerSeg = Math.ceil(totalRawSamples / tx.segments.size);
  const avgPerAxis = Math.max(1, Math.floor(avgRawPerSeg / div));

  // Walk through ALL expected segments in order, inserting NaN for gaps
  const axis: [number[], number[], number[]] = [[], [], []];
  const segRects: { i0: number; i1: number; color: string }[] = [];

  for (let segIdx = 0; segIdx < expected; segIdx++) {
    const pkt = tx.segments.get(segIdx);
    const state = states[segIdx] || 'grey';

    if (pkt) {
      // Received segment — deinterleave and append real data
      const i0 = axis[0].length || axis[1].length || axis[2].length;
      if (isTri) {
        for (let j = 0; j + 2 < pkt.Samples.length; j += 3) {
          axis[0].push(pkt.Samples[j]);
          axis[1].push(pkt.Samples[j + 1]);
          axis[2].push(pkt.Samples[j + 2]);
        }
      } else {
        const axIdx = (tx.axisMask & 0x01) ? 0 : (tx.axisMask & 0x02) ? 1 : 2;
        for (const s of pkt.Samples) axis[axIdx].push(s);
      }
      const i1 = axis[0].length || axis[1].length || axis[2].length;
      segRects.push({ i0, i1, color: STATE_COLORS[state] });
    } else {
      // Missing/pending segment — insert NaN placeholders
      const i0 = axis[0].length || axis[1].length || axis[2].length;
      if (isTri) {
        for (let j = 0; j < avgPerAxis; j++) {
          axis[0].push(NaN);
          axis[1].push(NaN);
          axis[2].push(NaN);
        }
      } else {
        const axIdx = (tx.axisMask & 0x01) ? 0 : (tx.axisMask & 0x02) ? 1 : 2;
        for (let j = 0; j < avgPerAxis; j++) axis[axIdx].push(NaN);
      }
      const i1 = axis[0].length || axis[1].length || axis[2].length;
      segRects.push({ i0, i1, color: STATE_COLORS[state] });
    }
  }

  const totalSamples = Math.max(axis[0].length, axis[1].length, axis[2].length);
  return { totalSamples, axis, segRects };
}

// ── CSV export ───────────────────────────────────────────────────────────────
export function buildCsvForTx(tx: Transaction): string {
  const wf = buildWaveformForPlot(tx);
  if (!wf) throw new Error('No waveform data to export');

  const isTri = tx.axisMask === 0x07;
  const axisLabel = AXIS_LABELS[tx.axisMask] || `0x${tx.axisMask.toString(16)}`;
  const hwFilter = tx.params?.HwFilter || 'unknown';

  // Waveform start time from first ingested segment
  const startTime = tx.firstIngestTime
    ? new Date(tx.firstIngestTime).toISOString()
    : 'unknown';

  // Metadata header
  const meta = [
    `# AirVibe Waveform Export`,
    `# Transaction ID: 0x${tx.txId.toString(16).padStart(2, '0')} (${tx.txId})`,
    `# Waveform Start Time: ${startTime}`,
    `# Axis Selection: ${axisLabel}`,
    `# Sample Rate: ${tx.sr} Hz`,
    `# Samples Per Axis: ${tx.samplesPerAxis}`,
    `# HW Filter: ${hwFilter}`,
    `# Segments: ${tx.segments.size}/${tx.expected ?? '?'}`,
    `# Status: ${tx.complete ? 'Complete' : 'Incomplete'}`,
    `#`,
  ];

  // Column header
  const colHeader = isTri
    ? 'sample,time_s,axis_1_accel_milligs,axis_2_accel_milligs,axis_3_accel_milligs'
    : (tx.axisMask & 0x01) ? 'sample,time_s,axis_1_accel_milligs'
    : (tx.axisMask & 0x02) ? 'sample,time_s,axis_2_accel_milligs'
    : 'sample,time_s,axis_3_accel_milligs';

  const lines = [...meta, colHeader];
  const sr = tx.sr || 1;

  for (let i = 0; i < wf.totalSamples; i++) {
    const t = (i / sr).toFixed(6);
    if (isTri) {
      const a1 = isNaN(wf.axis[0][i]) ? '' : wf.axis[0][i];
      const a2 = isNaN(wf.axis[1][i]) ? '' : wf.axis[1][i];
      const a3 = isNaN(wf.axis[2][i]) ? '' : wf.axis[2][i];
      lines.push(`${i},${t},${a1},${a2},${a3}`);
    } else {
      const axIdx = (tx.axisMask & 0x01) ? 0 : (tx.axisMask & 0x02) ? 1 : 2;
      const v = isNaN(wf.axis[axIdx][i]) ? '' : wf.axis[axIdx][i];
      lines.push(`${i},${t},${v}`);
    }
  }
  return lines.join('\n');
}

export function csvFilenameForTx(tx: Transaction): string {
  return `waveform_tx${tx.txId.toString(16).padStart(2, '0')}_${Date.now()}.csv`;
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Example data (DevEUI 8C1F642113000556, TxID 0x19, tri-axis 20kHz) ───────
export const EXAMPLE_PACKETS = [
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
].join('\n');
