"use client";

import { useState, useEffect, useCallback } from 'react';

interface DemoStatus {
  running: boolean;
  elapsed_seconds?: number;
  remaining_seconds?: number;
  duration_seconds?: number;
  sensors?: number;
  overall_rounds?: number;
  waveforms_captured?: number;
  recent_log?: string[];
}

export default function SensorSimulator() {
  const [demo, setDemo] = useState<DemoStatus>({ running: false });
  const [demoMinutes, setDemoMinutes] = useState(5);
  const [showLog, setShowLog] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  const fetchDemoStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/demo/status`);
      setDemo(await res.json());
    } catch {
      // silently ignore
    }
  }, [apiUrl]);

  useEffect(() => {
    const t = setTimeout(fetchDemoStatus, 0);
    const i = setInterval(fetchDemoStatus, 2000);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [fetchDemoStatus]);

  const startDemo = async () => {
    try {
      await fetch(`${apiUrl}/api/demo/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: demoMinutes }),
      });
      setTimeout(fetchDemoStatus, 500);
    } catch { /* ignore */ }
  };

  const stopDemo = async () => {
    try {
      await fetch(`${apiUrl}/api/demo/stop`, { method: 'POST' });
      setTimeout(fetchDemoStatus, 500);
    } catch { /* ignore */ }
  };

  const resetData = async () => {
    try {
      await fetch(`${apiUrl}/api/demo/reset`, { method: 'POST' });
    } catch { /* ignore */ }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="p-4">
      <div className="p-3 bg-[var(--av-bg-surface)] rounded border border-[var(--av-border)]">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-semibold text-[var(--av-text-subtle)] uppercase tracking-wider">Sensor Simulator</h3>
          {demo.running && demo.recent_log && demo.recent_log.length > 0 && (
            <button
              onClick={() => setShowLog(!showLog)}
              className="text-[10px] text-[var(--av-text-subtle)] hover:text-[var(--av-text-muted)] transition-colors"
            >
              {showLog ? 'Hide Log' : 'Show Log'}
            </button>
          )}
        </div>

        {demo.running ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[var(--av-accent)] animate-pulse" />
                <span className="text-[var(--av-accent)] font-semibold">Running</span>
              </span>
              <span className="text-[var(--av-text-subtle)]">
                {formatTime(demo.elapsed_seconds || 0)} / {formatTime(demo.duration_seconds || 0)}
              </span>
              <span className="text-[var(--av-text-subtle)]">{demo.sensors} sensors</span>
              <span className="text-[var(--av-text-subtle)]">{demo.overall_rounds} rounds</span>
              <span className="text-[var(--av-text-subtle)]">{demo.waveforms_captured} waveforms</span>
            </div>

            <div className="w-full bg-[var(--av-bg-base)] rounded-full h-1 overflow-hidden">
              <div
                className="bg-[var(--av-accent)] h-full transition-all duration-1000"
                style={{ width: `${((demo.elapsed_seconds || 0) / (demo.duration_seconds || 1)) * 100}%` }}
              />
            </div>

            {showLog && demo.recent_log && (
              <div className="mt-2 bg-[var(--av-bg-base)] rounded border border-[var(--av-border)] p-2 max-h-40 overflow-y-auto">
                {demo.recent_log.map((line, i) => (
                  <div key={i} className="text-[10px] font-mono text-[var(--av-text-subtle)] leading-relaxed">{line}</div>
                ))}
              </div>
            )}

            <button
              onClick={stopDemo}
              className="px-3 py-1 bg-[var(--av-accent-red)]/20 hover:bg-[var(--av-accent-red)]/40 text-[var(--av-accent-red)] text-xs rounded border border-[var(--av-accent-red)]/30 transition-colors"
            >
              Stop Demo
            </button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              onClick={startDemo}
              className="px-3 py-1.5 bg-[var(--av-accent)] hover:opacity-90 text-[var(--av-bg-base)] text-xs rounded transition-opacity font-medium"
            >
              Start Demo
            </button>
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-[var(--av-text-subtle)]">Duration</label>
              <select
                value={demoMinutes}
                onChange={(e) => setDemoMinutes(parseInt(e.target.value))}
                className="bg-[var(--av-bg-base)] border border-[var(--av-border)] rounded px-1.5 py-0.5 text-[10px] text-[var(--av-text-muted)] outline-none"
              >
                <option value={1}>1 min</option>
                <option value={2}>2 min</option>
                <option value={3}>3 min</option>
                <option value={5}>5 min</option>
                <option value={10}>10 min</option>
              </select>
            </div>
            <button
              onClick={resetData}
              className="px-3 py-1.5 bg-[var(--av-accent-red)]/10 hover:bg-[var(--av-accent-red)]/20 text-[var(--av-accent-red)] text-xs rounded transition-colors border border-[var(--av-accent-red)]/30"
            >
              Reset Data
            </button>
            <span className="text-[10px] text-[var(--av-text-subtle)]">3 simulated sensors with periodic vibration data and staggered waveform captures</span>
          </div>
        )}
      </div>
    </div>
  );
}
