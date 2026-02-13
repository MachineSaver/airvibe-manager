"use client";

import { useState, useEffect, useCallback } from 'react';
import MQTTMessageCard from './MQTTMessageCard';

interface Stats {
  total_devices: number;
  total_messages: number;
  messages_last_hour: number;
  total_waveforms: number;
}

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

interface MQTTMonitorProps {
  messages: { topic: string; payload: string; timestamp: string }[];
}

export default function MQTTMonitor({ messages }: MQTTMonitorProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [demo, setDemo] = useState<DemoStatus>({ running: false });
  const [demoMinutes, setDemoMinutes] = useState(5);
  const [showLog, setShowLog] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/stats`);
      setStats(await res.json());
    } catch {
      // silently ignore
    }
  }, [apiUrl]);

  const fetchDemoStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/demo/status`);
      setDemo(await res.json());
    } catch {
      // silently ignore
    }
  }, [apiUrl]);

  useEffect(() => {
    const t1 = setTimeout(fetchStats, 0);
    const i1 = setInterval(fetchStats, 5000);
    return () => { clearTimeout(t1); clearInterval(i1); };
  }, [fetchStats]);

  useEffect(() => {
    const t2 = setTimeout(fetchDemoStatus, 0);
    const i2 = setInterval(fetchDemoStatus, 2000);
    return () => { clearTimeout(t2); clearInterval(i2); };
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
      setTimeout(fetchStats, 500);
    } catch { /* ignore */ }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="overflow-auto p-4 space-y-2">
      {/* Stats Banner */}
      {stats && (
        <div className="flex gap-4 mb-2 p-3 bg-[#252526] rounded border border-[#333] text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">Devices</span>
            <span className="font-mono text-blue-400 font-bold">{stats.total_devices}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">Messages</span>
            <span className="font-mono text-green-400 font-bold">{stats.total_messages}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">Last Hour</span>
            <span className="font-mono text-yellow-400 font-bold">{stats.messages_last_hour}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">Waveforms</span>
            <span className="font-mono text-purple-400 font-bold">{stats.total_waveforms}</span>
          </div>
        </div>
      )}

      {/* Demo Simulator Control */}
      <div className="p-3 bg-[#252526] rounded border border-[#333]">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Sensor Simulator</h3>
          {demo.running && demo.recent_log && demo.recent_log.length > 0 && (
            <button
              onClick={() => setShowLog(!showLog)}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              {showLog ? 'Hide Log' : 'Show Log'}
            </button>
          )}
        </div>

        {demo.running ? (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-green-400 font-semibold">Running</span>
              </span>
              <span className="text-gray-500">
                {formatTime(demo.elapsed_seconds || 0)} / {formatTime(demo.duration_seconds || 0)}
              </span>
              <span className="text-gray-500">
                {demo.sensors} sensors
              </span>
              <span className="text-gray-500">
                {demo.overall_rounds} rounds
              </span>
              <span className="text-gray-500">
                {demo.waveforms_captured} waveforms
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-[#1e1e1e] rounded-full h-1 overflow-hidden">
              <div
                className="bg-green-500 h-full transition-all duration-1000"
                style={{ width: `${((demo.elapsed_seconds || 0) / (demo.duration_seconds || 1)) * 100}%` }}
              />
            </div>

            {/* Log output */}
            {showLog && demo.recent_log && (
              <div className="mt-2 bg-[#1e1e1e] rounded border border-[#3e3e42] p-2 max-h-40 overflow-y-auto">
                {demo.recent_log.map((line, i) => (
                  <div key={i} className="text-[10px] font-mono text-gray-500 leading-relaxed">{line}</div>
                ))}
              </div>
            )}

            <button
              onClick={stopDemo}
              className="px-3 py-1 bg-red-600/80 hover:bg-red-600 text-white text-xs rounded transition-colors"
            >
              Stop Demo
            </button>
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={startDemo}
              className="px-3 py-1.5 bg-green-600/80 hover:bg-green-600 text-white text-xs rounded transition-colors font-medium"
            >
              Start Demo
            </button>
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-gray-500">Duration</label>
              <select
                value={demoMinutes}
                onChange={(e) => setDemoMinutes(parseInt(e.target.value))}
                className="bg-[#1e1e1e] border border-[#3e3e42] rounded px-1.5 py-0.5 text-[10px] text-gray-300 outline-none"
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
              className="px-3 py-1.5 bg-red-600/30 hover:bg-red-600/60 text-red-400 text-xs rounded transition-colors border border-red-600/30"
            >
              Reset Data
            </button>
            <span className="text-[10px] text-gray-600">3 simulated sensors with periodic vibration data and staggered waveform captures</span>
          </div>
        )}
      </div>

      {/* Messages */}
      {messages.length === 0 && (
        <div className="text-gray-500 text-center mt-10">No messages received yet.</div>
      )}
      {messages.map((msg, idx) => (
        <MQTTMessageCard
          key={idx}
          topic={msg.topic}
          payload={msg.payload}
          timestamp={msg.timestamp}
        />
      ))}
    </div>
  );
}
