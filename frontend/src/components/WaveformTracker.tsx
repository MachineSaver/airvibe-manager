'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSettings, AccelUnit } from '@/contexts/SettingsContext';
import {
  COL,
  type ParamsPacket,
  type Packet,
  type Transaction,
  type WaveState,
  decodePacket,
  assemble,
  segmentStates,
  buildWaveformForPlot,
  buildCsvForTx,
  csvFilenameForTx,
  downloadText,
  EXAMPLE_PACKETS,
} from '../utils/waveformTracker';

// mg → display unit conversion (same factors as WaveformChart)
const ACCEL_FROM_MG: Record<AccelUnit, number> = {
    'g':        1 / 1000,
    'mg':       1,
    'm/s²':     9.81  / 1000,
    'mm/s²':    9810  / 1000,
    'inch/s²':  386.09 / 1000,
};

// --- SVG waveform plot ----------------------------------------------------
function useResize(elRef: React.RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!elRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(300, e.contentRect.width));
    });
    ro.observe(elRef.current);
    return () => ro.disconnect();
  }, [elRef]);
  return w;
}

function SvgWave({ tx }: { tx: Transaction }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const width = useResize(hostRef);
  const { settings } = useSettings();
  const height = 320;
  const pad = { l: 58, r: 16, t: 12, b: 28 };
  const wf = useMemo(() => buildWaveformForPlot(tx), [tx]);
  const contentW = Math.max(10, width - pad.l - pad.r);
  const contentH = Math.max(10, height - pad.t - pad.b);

  if (!wf) return <div ref={hostRef} style={{ height }} />;

  const conv = ACCEL_FROM_MG[settings.accelUnit];
  const N = wf.totalSamples || 1;
  const xs = (i: number) => pad.l + (i / (N - 1 || 1)) * contentW;
  const isTri = tx.axisMask === 0x07;
  const activeAxes = isTri ? [0, 1, 2] : (tx.axisMask & 0x01) ? [0] : (tx.axisMask & 0x02) ? [1] : (tx.axisMask & 0x04) ? [2] : [0];
  const convertAxis = (arr: number[]) => arr.map(v => isNaN(v) ? v : v * conv);
  const allY = activeAxes.flatMap(ai => convertAxis(wf.axis[ai])).filter(v => !isNaN(v));
  let ymin = Math.min(...allY, 0);
  let ymax = Math.max(...allY, 0);
  if (ymin === ymax) { ymin = -1; ymax = 1; }
  const ys = (v: number) => pad.t + (1 - (v - ymin) / (ymax - ymin)) * contentH;
  const pathD = (arr: number[]) => {
    const converted = convertAxis(arr);
    let d = '';
    for (let i = 0; i < converted.length; i++) {
      if (isNaN(converted[i])) continue;
      const cmd = (i === 0 || isNaN(converted[i - 1])) ? 'M' : 'L';
      d += `${cmd}${xs(i)},${ys(converted[i])}`;
    }
    return d;
  };
  const clipId = `clip-${tx.txId}`;
  const axisColors = [COL.axis1, COL.axis2, COL.axis3];
  const axisLabels = ['Axis 1', 'Axis 2', 'Axis 3'];
  const fmt = (v: number) => Math.abs(v) >= 1000 ? v.toExponential(1) : +v.toPrecision(3) + '';

  return (
    <div ref={hostRef} className="w-full">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.l} y={pad.t} width={contentW} height={contentH} />
          </clipPath>
        </defs>
        <rect x={pad.l} y={pad.t} width={contentW} height={contentH} fill="#0b1730" stroke="#1f2937" />
        <g clipPath={`url(#${clipId})`}>
          {wf.segRects.map((r, i) => (
            <rect key={i} x={xs(r.i0)} y={pad.t} width={xs(r.i1) - xs(r.i0)} height={contentH} fill={r.color} opacity="0.22" />
          ))}
        </g>
        {activeAxes.map((ai) => (
          <path key={ai} fill="none" stroke={axisColors[ai]} strokeWidth="2" d={pathD(wf.axis[ai])} />
        ))}
        {[ymin, (ymin + ymax) / 2, ymax].map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={pad.l + contentW} y1={ys(v)} y2={ys(v)} stroke="#334155" strokeDasharray="3 4" />
            <text x={pad.l - 4} y={ys(v) + 4} fontSize="10" textAnchor="end" fill="#94a3b8">{fmt(v)}</text>
          </g>
        ))}
        {/* Y-axis unit label */}
        <text
          x={12} y={pad.t + contentH / 2}
          fontSize="10" fill="#64748b" textAnchor="middle"
          transform={`rotate(-90, 12, ${pad.t + contentH / 2})`}
        >
          {settings.accelUnit}
        </text>
        {activeAxes.map((ai, i) => (
          <g key={ai} transform={`translate(${pad.l + i * 90}, ${height - pad.b + 16})`}>
            <rect x={0} y={-10} width={18} height={3} fill={axisColors[ai]} />
            <text x={24} y={-6} fontSize="11" fill="#cbd5e1">{axisLabels[ai]}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// --- Segment grid ---------------------------------------------------------
function SegmentsGrid({ tx }: { tx: Transaction }) {
  const states = segmentStates(tx);
  return (
    <div className="flex flex-wrap gap-2">
      {states.map((st, i) => (
        <div
          key={i}
          className="flex items-center justify-center w-9 h-9 rounded-full text-xs font-mono"
          style={{
            background: '#f8fafc',
            color: '#334155',
            outline: `3px solid ${COL[st as keyof typeof COL]}`,
            outlineOffset: '2px',
          }}
        >
          {i}
        </div>
      ))}
    </div>
  );
}

// --- Hex display ----------------------------------------------------------
function CodeHex({ bytes }: { bytes: Uint8Array }) {
  if (!bytes) return null;
  const s = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
  return <code className="text-xs break-words whitespace-pre-wrap font-mono text-[var(--av-text-subtle)]">{s}</code>;
}

// --- Legend ----------------------------------------------------------------
function Legend() {
  const items = [
    { color: COL.green, label: 'Received' },
    { color: COL.red, label: 'Missing' },
    { color: COL.yellow, label: 'Requested' },
    { color: COL.grey, label: 'Pending' },
  ];
  return (
    <div className="flex flex-wrap gap-3">
      {items.map(({ color, label }) => (
        <div key={label} className="flex items-center gap-1.5 text-xs text-[var(--av-text-subtle)]">
          <span className="w-3 h-3 rounded-full inline-block" style={{ background: color }} />
          {label}
        </div>
      ))}
    </div>
  );
}

// --- Main component -------------------------------------------------------
export default function WaveformTracker() {
  const [hexInput, setHexInput] = useState('');
  const [log, setLog] = useState<Packet[]>([]);
  const [waves, setWaves] = useState<WaveState>({});
  const [error, setError] = useState<string | null>(null);

  const onIngest = () => {
    setError(null);
    try {
      const lines = hexInput.split(/\n+/).map(s => s.trim()).filter(Boolean);
      const newPkts = lines.map(decodePacket);
      const newLog = [...log, ...newPkts];
      let state = { ...waves };
      for (const p of newPkts) state = assemble(state, p);
      setLog(newLog);
      setWaves(state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onReset = () => {
    setHexInput('');
    setLog([]);
    setWaves({});
    setError(null);
  };

  const activeTxIds = useMemo(
    () => Object.keys(waves).map(k => parseInt(k, 10)).sort((a, b) => a - b),
    [waves],
  );

  const handleDownload = (tx: Transaction) => {
    try {
      const csv = buildCsvForTx(tx);
      downloadText(csvFilenameForTx(tx), csv);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center gap-4 mb-6">
        <h4 className="text-2xl font-bold text-[var(--av-text-primary)]">Waveform Tracker</h4>
        <div className="h-px bg-[var(--av-border)] flex-1"></div>
      </div>
      <p className="text-sm text-[var(--av-text-subtle)] mb-4">
        Paste hex-encoded uplink packets (Types 01, 03, 05) to decode, assemble, and visualize time waveform data.
      </p>

      <div className="bg-[var(--av-bg-surface)] rounded-lg border border-[var(--av-border)] overflow-hidden">
        {/* Input area */}
        <div className="px-4 py-4 space-y-3">
          <textarea
            className="w-full h-32 rounded-md border border-[var(--av-border)] bg-[var(--av-bg-base)] p-3 font-mono text-xs text-[var(--av-text-muted)] placeholder-[var(--av-text-subtle)] focus:outline-none focus:border-[var(--av-accent-cyan)] resize-y"
            placeholder="Paste hex packets here, one per line (e.g., 03210000070003814e200015)"
            value={hexInput}
            onChange={e => setHexInput(e.target.value)}
          />
          <div className="flex gap-2 flex-wrap">
            <button
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--av-bg-raised)] text-[var(--av-text-muted)] hover:bg-[var(--av-bg-hover)] border border-[var(--av-border)] transition-colors"
              onClick={() => setHexInput(EXAMPLE_PACKETS)}
            >
              Fill Example
            </button>
            <button
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--av-accent-cyan)] text-[var(--av-bg-base)] hover:opacity-90 transition-opacity"
              onClick={onIngest}
            >
              Ingest
            </button>
            {log.length > 0 && (
              <button
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--av-bg-raised)] text-[var(--av-text-muted)] hover:bg-[var(--av-bg-hover)] border border-[var(--av-border)] transition-colors"
                onClick={onReset}
              >
                Reset
              </button>
            )}
          </div>
          {error && (
            <div className="text-sm text-[var(--av-accent-red)] bg-[var(--av-accent-red)]/10 border border-[var(--av-accent-red)]/40 rounded-md px-3 py-2">{error}</div>
          )}
        </div>

        {/* Transactions */}
        {activeTxIds.length > 0 && (
          <div className="border-t border-[var(--av-border)] divide-y divide-[var(--av-border)]">
            {activeTxIds.map(txId => {
              const tx = waves[txId];
              return (
                <div key={txId} className="px-4 py-4 space-y-4">
                  {/* Transaction header */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-sm font-semibold text-[var(--av-text-primary)]">
                      Transaction <span className="font-mono">0x{txId.toString(16).padStart(2, '0')}</span>
                    </span>
                    {tx.params ? (
                      <span className="text-xs font-mono text-[var(--av-text-muted)] bg-[var(--av-bg-raised)] border border-[var(--av-border)] px-2 py-1 rounded">
                        {tx.params.AxisSelectionText} &middot; {tx.sr} Hz &middot; {tx.expected} segs &middot; {tx.samplesPerAxis} samples/axis
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--av-accent-amber)] bg-[var(--av-accent-amber)]/10 border border-[var(--av-accent-amber)]/30 px-2 py-1 rounded">Waiting for Time Waveform Information Uplink (Type 03)</span>
                    )}
                  </div>

                  {/* Segment map */}
                  {tx.expected != null && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-[var(--av-text-subtle)] uppercase tracking-wider">Segment Map</span>
                        <Legend />
                      </div>
                      <SegmentsGrid tx={tx} />
                    </div>
                  )}

                  {/* Suggested downlinks */}
                  {tx.downlinks.length > 0 && (
                    <div>
                      <span className="text-xs font-medium text-[var(--av-text-subtle)] uppercase tracking-wider block mb-2">Suggested Downlinks</span>
                      <div className="flex flex-wrap gap-2">
                        {tx.downlinks.map((d, i) => (
                          <span key={i} className="inline-flex items-center gap-1.5 text-xs bg-[var(--av-bg-raised)] border border-[var(--av-border)] text-[var(--av-text-muted)] rounded px-2 py-1 font-mono">
                            {d.label} &middot; Port {d.port} &middot; {d.hex}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Waveform plot */}
                  {tx.params && (
                    <div className="rounded-md border border-[var(--av-border)] overflow-hidden">
                      <SvgWave tx={tx} />
                    </div>
                  )}

                  {/* CSV download */}
                  {tx.complete && (
                    <button
                      className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--av-accent)] text-[var(--av-bg-base)] hover:opacity-90 transition-opacity"
                      onClick={() => handleDownload(tx)}
                    >
                      Download Waveform CSV
                    </button>
                  )}

                  {/* Packet log */}
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-[var(--av-text-subtle)] hover:text-[var(--av-text-muted)] transition-colors">
                      Packet log ({tx.segments.size} segments)
                    </summary>
                    <div className="mt-2 space-y-2">
                      {[...tx.segments.entries()].sort((a, b) => a[0] - b[0]).map(([segNo, pkt]) => (
                        <div key={segNo} className="rounded-md bg-[var(--av-bg-base)] border border-[var(--av-border)] p-3">
                          <div className="text-xs text-[var(--av-text-subtle)] mb-1">
                            Segment {segNo} &middot; Type {pkt.PacketType === 5 ? '05 (last)' : '01'}
                          </div>
                          <CodeHex bytes={pkt._raw} />
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        )}

        {/* Ingested packet summary */}
        {log.length > 0 && (
          <div className="px-4 py-3 border-t border-[var(--av-border)] bg-[var(--av-bg-base)]">
            <details>
              <summary className="cursor-pointer text-xs font-medium text-[var(--av-text-subtle)] hover:text-[var(--av-text-muted)] transition-colors">
                All ingested packets ({log.length})
              </summary>
              <div className="mt-2 space-y-1">
                {log.map((p, idx) => (
                  <div key={idx} className="text-xs text-[var(--av-text-subtle)]">
                    Type {p.PacketType.toString(16).padStart(2, '0').toUpperCase()} &middot; TxID {p.TransactionID} &middot; Seg {p.SegmentNumber}
                    {p.LastSegment ? ' (last)' : ''}
                    {p.PacketType === 3 && ` · ${(p as ParamsPacket).AxisSelectionText}, ${(p as ParamsPacket).NumberOfSegments} segs, ${(p as ParamsPacket).SamplingRate_Hz} Hz`}
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}

        {/* Help section */}
        <div className="px-4 py-5 border-t border-[var(--av-border)] bg-[var(--av-bg-base)]">
          <h5 className="text-sm font-semibold text-[var(--av-text-muted)] mb-2">How does this work?</h5>
          <p className="text-sm text-[var(--av-text-subtle)] leading-relaxed mb-2">
            Time waveform data is transmitted from the sensor as a series of LoRaWAN uplinks. A <strong className="text-[var(--av-text-muted)]">Type 03</strong> packet
            announces the transfer parameters (axes, sampling rate, segment count). <strong className="text-[var(--av-text-muted)]">Type 01</strong> packets carry
            the actual sample data, and a final <strong className="text-[var(--av-text-muted)]">Type 05</strong> packet signals the end of the transfer.
          </p>
          <p className="text-sm text-[var(--av-text-subtle)] leading-relaxed">
            Paste packets in order as they arrive. The tracker assembles them, highlights missing segments, suggests
            the appropriate downlink responses, and plots the reconstructed waveform. When all segments are received,
            you can export the assembled data as CSV.
          </p>
        </div>
      </div>
    </div>
  );
}
