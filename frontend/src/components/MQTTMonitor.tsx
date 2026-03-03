"use client";

import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Socket } from 'socket.io-client';
import MQTTMessageCard from './MQTTMessageCard';
import DownlinkBuilder from './DownlinkBuilder';

interface Stats {
  total_devices: number;
  total_messages: number;
  messages_last_hour: number;
  total_waveforms: number;
}

interface MQTTMonitorProps {
  messages: { topic: string; payload: string; timestamp: string; _key: string }[];
  socket: Socket | null;
}

export default function MQTTMonitor({ messages, socket }: MQTTMonitorProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [filterDevEui, setFilterDevEui] = useState('');
  const [filterDirection, setFilterDirection] = useState<'all' | 'uplink' | 'downlink'>('all');
  const [apiDevEuis, setApiDevEuis] = useState<string[]>([]);
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [collapseKey, setCollapseKey] = useState(0);
  const [expandKey, setExpandKey] = useState(0);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/stats`);
      setStats(await res.json());
    } catch {
      // silently ignore
    }
  }, [apiUrl]);

  useEffect(() => {
    const t1 = setTimeout(fetchStats, 0);
    const i1 = setInterval(fetchStats, 5000);
    return () => { clearTimeout(t1); clearInterval(i1); };
  }, [fetchStats]);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/devices`);
      const data = await res.json();
      setApiDevEuis(data.map((d: { dev_eui: string }) => d.dev_eui));
    } catch {
      // silently ignore
    }
  }, [apiUrl]);

  useEffect(() => {
    const timeout = setTimeout(fetchDevices, 0);
    const interval = setInterval(fetchDevices, 10000);
    return () => { clearTimeout(timeout); clearInterval(interval); };
  }, [fetchDevices]);

  // Build known DevEUIs from API registry + live message topics
  const knownDevEuis = useMemo(() => {
    const euis = new Set<string>(apiDevEuis);
    for (const msg of messages) {
      const match = msg.topic.match(/mqtt\/things\/([^/]+)\//);
      if (match) euis.add(match[1]);
    }
    return euis;
  }, [apiDevEuis, messages]);

  // Client-side filter
  const filtered = messages.filter(msg => {
    if (filterDevEui && !msg.topic.includes(filterDevEui)) return false;
    if (filterDirection === 'uplink' && !msg.topic.endsWith('/uplink')) return false;
    if (filterDirection === 'downlink' && !msg.topic.endsWith('/downlink')) return false;
    return true;
  });

  // Scroll anchor — preserve position when scrollTop > 0 (reading history)
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollHeight = useRef(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Adjust scrollTop if user has scrolled down (reading history)
    if (el.scrollTop > 0 && prevScrollHeight.current > 0) {
      const diff = el.scrollHeight - prevScrollHeight.current;
      if (diff > 0) el.scrollTop += diff;
    }
    // Capture current scrollHeight for next render
    prevScrollHeight.current = el.scrollHeight;
  });

  return (
    <div className="overflow-auto p-4 space-y-2">
      {/* Stats Banner */}
      {stats && (
        <div className="flex flex-wrap gap-4 p-3 bg-[#252526] rounded border border-[#333] text-xs">
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

      {/* Downlink Builder (collapsed by default) */}
      <DownlinkBuilder socket={socket} messages={messages} />

      {/* Stream Controls */}
      <div className="p-3 bg-[#252526] rounded border border-[#333] flex flex-wrap items-center gap-3">
        {knownDevEuis.size > 0 && !isCustomMode ? (
          <select
            value={filterDevEui}
            onChange={e => {
              const val = e.target.value;
              if (val === '__custom__') {
                setIsCustomMode(true);
                setFilterDevEui('');
              } else {
                setFilterDevEui(val);
              }
            }}
            className="bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none w-48"
          >
            <option value="">-- All DevEUIs --</option>
            {Array.from(knownDevEuis).map(id => (
              <option key={id} value={id}>{id}</option>
            ))}
            <option value="__custom__">-- Enter Custom DevEUI --</option>
          </select>
        ) : (
          <div className="relative">
            <input
              type="text"
              value={filterDevEui}
              onChange={e => setFilterDevEui(e.target.value)}
              placeholder="Filter by DevEUI…"
              className="bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none w-48"
              autoFocus={isCustomMode}
            />
            {knownDevEuis.size > 0 && (
              <button
                onClick={() => { setIsCustomMode(false); setFilterDevEui(''); }}
                className="absolute right-2 top-1/2 transform -translate-y-1/2 text-[10px] text-blue-400 hover:text-blue-300"
              >
                List
              </button>
            )}
          </div>
        )}
        <select
          value={filterDirection}
          onChange={e => setFilterDirection(e.target.value as 'all' | 'uplink' | 'downlink')}
          className="bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 outline-none"
        >
          <option value="all">All</option>
          <option value="uplink">Uplink</option>
          <option value="downlink">Downlink</option>
        </select>
        <div className="flex gap-2 ml-auto">
          <button
            onClick={() => setCollapseKey(k => k + 1)}
            className="px-2 py-1 text-[10px] bg-[#1e1e1e] border border-[#3e3e42] rounded text-gray-400 hover:text-gray-200 transition-colors"
          >
            Collapse All
          </button>
          <button
            onClick={() => setExpandKey(k => k + 1)}
            className="px-2 py-1 text-[10px] bg-[#1e1e1e] border border-[#3e3e42] rounded text-gray-400 hover:text-gray-200 transition-colors"
          >
            Expand All
          </button>
        </div>
      </div>

      {/* Message Stream */}
      <div ref={scrollRef}>
        {filtered.length === 0 && (
          <div className="text-gray-500 text-center mt-10 text-sm">
            {messages.length === 0 ? 'No messages received yet.' : 'No messages match the current filter.'}
          </div>
        )}
        {filtered.map((msg) => (
          <MQTTMessageCard
            key={msg._key}
            topic={msg.topic}
            payload={msg.payload}
            timestamp={msg.timestamp}
            collapseKey={collapseKey}
            expandKey={expandKey}
          />
        ))}
      </div>
    </div>
  );
}
