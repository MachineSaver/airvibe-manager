
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const height = 320;
  const pad = { l: 50, r: 16, t: 12, b: 28 };
  const wf = useMemo(() => buildWaveformForPlot(tx), [tx]);
  const contentW = Math.max(10, width - pad.l - pad.r);
  const contentH = Math.max(10, height - pad.t - pad.b);

  if (!wf) return <div ref={hostRef} style={{ height }} />;

  const N = wf.totalSamples || 1;
  const xs = (i: number) => pad.l + (i / (N - 1 || 1)) * contentW;
  const isTri = tx.axisMask === 0x07;
  const activeAxes = isTri ? [0, 1, 2] : (tx.axisMask & 0x01) ? [0] : (tx.axisMask & 0x02) ? [1] : (tx.axisMask & 0x04) ? [2] : [0];
  const allY = activeAxes.flatMap(ai => wf.axis[ai]);
  let ymin = Math.min(...allY, 0);
  let ymax = Math.max(...allY, 0);
  if (ymin === ymax) { ymin = -1; ymax = 1; }
  const ys = (v: number) => pad.t + (1 - (v - ymin) / (ymax - ymin)) * contentH;
  const poly = (arr: number[]) => arr.map((y, i) => `${xs(i)},${ys(y)}`).join(' ');
  const clipId = `clip-${tx.txId}`;
  const axisColors = [COL.axis1, COL.axis2, COL.axis3];
  const axisLabels = ['Axis 1', 'Axis 2', 'Axis 3'];

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
          <polyline key={ai} fill="none" stroke={axisColors[ai]} strokeWidth="2" points={poly(wf.axis[ai])} />
        ))}
        {[ymin, 0, ymax].map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={pad.l + contentW} y1={ys(v)} y2={ys(v)} stroke="#334155" strokeDasharray="3 4" />
            <text x={pad.l - 6} y={ys(v) + 4} fontSize="10" textAnchor="end" fill="#94a3b8">{v}</text>
          </g>
        ))}
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
  return <code className="text-xs break-words whitespace-pre-wrap font-mono text-slate-500">{s}</code>;
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
        <div key={label} className="flex items-center gap-1.5 text-xs text-slate-500">
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
    <div className="my-8 group/tracker">
      <div className="flex items-center gap-4 mb-6">
        <h4 className="text-2xl font-bold text-slate-900 group-hover/tracker:text-blue-600 transition-colors">Waveform Tracker</h4>
        <div className="h-px bg-slate-200 flex-1"></div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Paste hex-encoded uplink packets (Types 01, 03, 05) to decode, assemble, and visualize time waveform data.
      </p>

      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        {/* Input area */}
        <div className="px-4 py-4 space-y-3">
          <textarea
            className="w-full h-32 rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
            placeholder="Paste hex packets here, one per line (e.g., 03210000070003814e200015)"
            value={hexInput}
            onChange={e => setHexInput(e.target.value)}
          />
          <div className="flex gap-2 flex-wrap">
            <button
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
              onClick={() => setHexInput(EXAMPLE_PACKETS)}
            >
              Fill Example
            </button>
            <button
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
              onClick={onIngest}
            >
              Ingest
            </button>
            {log.length > 0 && (
              <button
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                onClick={onReset}
              >
                Reset
              </button>
            )}
          </div>
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>
          )}
        </div>

        {/* Transactions */}
        {activeTxIds.length > 0 && (
          <div className="border-t border-slate-200 divide-y divide-slate-100">
            {activeTxIds.map(txId => {
              const tx = waves[txId];
              return (
                <div key={txId} className="px-4 py-4 space-y-4">
                  {/* Transaction header */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-sm font-semibold text-slate-700">
                      Transaction <span className="font-mono">0x{txId.toString(16).padStart(2, '0')}</span>
                    </span>
                    {tx.params ? (
                      <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-1 rounded">
                        {tx.params.AxisSelectionText} &middot; {tx.sr} Hz &middot; {tx.expected} segs &middot; {tx.samplesPerAxis} samples/axis
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">Waiting for Time Waveform Information Uplink (Type 03)</span>
                    )}
                  </div>

                  {/* Segment map */}
                  {tx.expected != null && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Segment Map</span>
                        <Legend />
                      </div>
                      <SegmentsGrid tx={tx} />
                    </div>
                  )}

                  {/* Suggested downlinks */}
                  {tx.downlinks.length > 0 && (
                    <div>
                      <span className="text-xs font-medium text-slate-500 uppercase tracking-wider block mb-2">Suggested Downlinks</span>
                      <div className="flex flex-wrap gap-2">
                        {tx.downlinks.map((d, i) => (
                          <span key={i} className="inline-flex items-center gap-1.5 text-xs bg-slate-100 text-slate-600 rounded px-2 py-1 font-mono">
                            {d.label} &middot; Port {d.port} &middot; {d.hex}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Waveform plot */}
                  {tx.params && (
                    <div className="rounded-md border border-slate-200 overflow-hidden">
                      <SvgWave tx={tx} />
                    </div>
                  )}

                  {/* CSV download */}
                  {tx.complete && (
                    <button
                      className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                      onClick={() => handleDownload(tx)}
                    >
                      Download Waveform CSV
                    </button>
                  )}

                  {/* Packet log */}
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors">
                      Packet log ({tx.segments.size} segments)
                    </summary>
                    <div className="mt-2 space-y-2">
                      {[...tx.segments.entries()].sort((a, b) => a[0] - b[0]).map(([segNo, pkt]) => (
                        <div key={segNo} className="rounded-md bg-slate-50 border border-slate-100 p-3">
                          <div className="text-xs text-slate-600 mb-1">
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
          <div className="px-4 py-3 border-t border-slate-200 bg-slate-50">
            <details>
              <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors">
                All ingested packets ({log.length})
              </summary>
              <div className="mt-2 space-y-1">
                {log.map((p, idx) => (
                  <div key={idx} className="text-xs text-slate-600">
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
        <div className="px-4 py-5 border-t border-slate-200 bg-slate-50">
          <h5 className="text-sm font-semibold text-slate-700 mb-2">How does this work?</h5>
          <p className="text-sm text-slate-600 leading-relaxed mb-2">
            Time waveform data is transmitted from the sensor as a series of LoRaWAN uplinks. A <strong>Type 03</strong> packet
            announces the transfer parameters (axes, sampling rate, segment count). <strong>Type 01</strong> packets carry
            the actual sample data, and a final <strong>Type 05</strong> packet signals the end of the transfer.
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">
            Paste packets in order as they arrive. The tracker assembles them, highlights missing segments, suggests
            the appropriate downlink responses, and plots the reconstructed waveform. When all segments are received,
            you can export the assembled data as CSV.
          </p>
        </div>
      </div>
    </div>
  );
}
