"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

interface HistorianMessage {
  id: string;
  device_eui: string;
  topic: string;
  direction: string;
  payload: unknown;
  received_at: string;
}

function payloadToString(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

function payloadPretty(payload: unknown): string {
  if (typeof payload === 'string') {
    try { return JSON.stringify(JSON.parse(payload), null, 2); } catch { return payload; }
  }
  return JSON.stringify(payload, null, 2);
}

function truncate(s: unknown, max = 80): string {
  const str = payloadToString(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export default function Historian() {
  const [deviceEui, setDeviceEui] = useState('');
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [apiDevEuis, setApiDevEuis] = useState<string[]>([]);
  const [direction, setDirection] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [results, setResults] = useState<HistorianMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fromRef = useRef<HTMLInputElement>(null);
  const toRef   = useRef<HTMLInputElement>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  // Fetch known DevEUIs from device registry
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
    const t = setTimeout(fetchDevices, 0);
    return () => clearTimeout(t);
  }, [fetchDevices]);

  const search = async (newOffset = 0) => {
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams();
      if (deviceEui) params.set('device_eui', deviceEui);
      if (direction !== 'all') params.set('direction', direction);
      if (fromDate) params.set('from', new Date(fromDate).toISOString());
      if (toDate) params.set('to', new Date(toDate).toISOString());
      params.set('limit', String(limit));
      params.set('offset', String(newOffset));

      const res = await fetch(`${apiUrl}/api/messages?${params}`);
      const data = await res.json();
      const totalCount = parseInt(res.headers.get('X-Total-Count') || '0', 10);
      setResults(data);
      setTotal(totalCount);
      setOffset(newOffset);
      setExpandedIds(new Set());
    } catch {
      setResults([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    search(0);
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const copyPayload = (msg: HistorianMessage) => {
    const text = payloadPretty(msg.payload);
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  // Open native date picker on any click within the input
  type InputWithPicker = HTMLInputElement & { showPicker?: () => void };
  const openPicker = (ref: React.RefObject<HTMLInputElement | null>) =>
    () => (ref.current as InputWithPicker)?.showPicker?.();

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="h-full overflow-auto p-4">
      {/* Search form */}
      <form onSubmit={handleSubmit} className="bg-[#252526] rounded border border-[#333] p-4 mb-4">
        <h2 className="text-xs font-semibold text-yellow-400 uppercase mb-3">Message History Search</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">

          {/* DevEUI — dropdown of known devices or free-type */}
          <div>
            <label className="block text-[10px] text-gray-500 mb-1">DevEUI</label>
            {apiDevEuis.length > 0 && !isCustomMode ? (
              <select
                value={deviceEui}
                onChange={e => {
                  if (e.target.value === '__custom__') {
                    setIsCustomMode(true);
                    setDeviceEui('');
                  } else {
                    setDeviceEui(e.target.value);
                  }
                }}
                className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 outline-none font-mono"
              >
                <option value="">All devices</option>
                {apiDevEuis.map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
                <option value="__custom__">— Enter custom DevEUI —</option>
              </select>
            ) : (
              <div className="flex gap-1">
                <input
                  type="text"
                  value={deviceEui}
                  onChange={e => setDeviceEui(e.target.value)}
                  placeholder="e.g. 8C1F64…"
                  className="flex-1 min-w-0 bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none font-mono"
                />
                {apiDevEuis.length > 0 && (
                  <button
                    type="button"
                    onClick={() => { setIsCustomMode(false); setDeviceEui(''); }}
                    title="Back to list"
                    className="px-2 py-1 text-[10px] bg-[#1e1e1e] border border-[#3e3e42] rounded text-gray-400 hover:text-gray-200 transition-colors"
                  >
                    ↩
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Direction */}
          <div>
            <label className="block text-[10px] text-gray-500 mb-1">Direction</label>
            <select
              value={direction}
              onChange={e => setDirection(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 outline-none"
            >
              <option value="all">All</option>
              <option value="uplink">Uplink</option>
              <option value="downlink">Downlink</option>
            </select>
          </div>

          {/* From — click anywhere to open picker */}
          <div>
            <label className="block text-[10px] text-gray-500 mb-1">From</label>
            <input
              ref={fromRef}
              type="datetime-local"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              onClick={openPicker(fromRef)}
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none cursor-pointer"
            />
          </div>

          {/* To — click anywhere to open picker */}
          <div>
            <label className="block text-[10px] text-gray-500 mb-1">To</label>
            <input
              ref={toRef}
              type="datetime-local"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              onClick={openPicker(toRef)}
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none cursor-pointer"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="px-4 py-1.5 bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 text-white text-xs font-medium rounded transition-colors"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* Results */}
      {searched && !loading && (
        <>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500">
              {total === 0
                ? 'No results'
                : `${total} result${total !== 1 ? 's' : ''} · page ${currentPage} of ${totalPages}`}
            </span>
            {total > limit && (
              <div className="flex gap-2">
                <button
                  onClick={() => search(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                  className="px-2 py-1 text-[10px] bg-[#252526] border border-[#333] rounded text-gray-400 hover:text-gray-200 disabled:opacity-40 transition-colors"
                >
                  ← Prev
                </button>
                <button
                  onClick={() => search(offset + limit)}
                  disabled={offset + limit >= total}
                  className="px-2 py-1 text-[10px] bg-[#252526] border border-[#333] rounded text-gray-400 hover:text-gray-200 disabled:opacity-40 transition-colors"
                >
                  Next →
                </button>
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div className="overflow-x-auto rounded border border-[#333]">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-[#252526]">
                  <tr className="text-gray-500 border-b border-[#333]">
                    <th className="px-3 py-2 text-left whitespace-nowrap">Received At</th>
                    <th className="px-3 py-2 text-left">DevEUI</th>
                    <th className="px-3 py-2 text-left">Direction</th>
                    <th className="px-3 py-2 text-left">Topic</th>
                    <th className="px-3 py-2 text-left">Payload</th>
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(msg => {
                    const isExpanded = expandedIds.has(msg.id);
                    return (
                      <Fragment key={msg.id}>
                        <tr className="border-b border-[#2a2a2a] hover:bg-[#252526] transition-colors">
                          <td className="px-3 py-2 text-gray-400 whitespace-nowrap font-mono">
                            {new Date(msg.received_at).toLocaleString()}
                          </td>
                          <td className="px-3 py-2 font-mono text-gray-300 whitespace-nowrap">
                            {msg.device_eui || <span className="text-gray-600">—</span>}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-mono ${
                              msg.direction === 'uplink'
                                ? 'bg-teal-900/30 text-teal-400'
                                : msg.direction === 'downlink'
                                ? 'bg-purple-900/30 text-purple-400'
                                : 'bg-[#2a2a2a] text-gray-500'
                            }`}>
                              {msg.direction || '?'}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-gray-400 text-[10px] max-w-[200px] truncate" title={msg.topic}>
                            {msg.topic}
                          </td>
                          {/* Payload — chevron + truncated text */}
                          <td className="px-3 py-2 font-mono text-[10px] max-w-[300px]">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleExpanded(msg.id)}
                                title={isExpanded ? 'Collapse' : 'Expand payload'}
                                className="shrink-0 text-gray-500 hover:text-gray-300 transition-colors leading-none"
                              >
                                {isExpanded ? '▼' : '▶'}
                              </button>
                              <span className="truncate text-gray-500" title={payloadToString(msg.payload)}>
                                {truncate(msg.payload)}
                              </span>
                            </div>
                          </td>
                          {/* Copy button */}
                          <td className="px-2 py-2 text-center">
                            <button
                              type="button"
                              onClick={() => copyPayload(msg)}
                              title="Copy payload JSON"
                              className="p-1 hover:bg-[#3e3e42] rounded text-gray-400 hover:text-blue-400 transition-colors"
                            >
                              {copiedId === msg.id ? (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          </td>
                        </tr>
                        {/* Expanded payload row */}
                        {isExpanded && (
                          <tr className="border-b border-[#333] bg-[#1a1a1a]">
                            <td colSpan={6} className="px-4 py-3">
                              <pre className="font-mono text-[11px] text-green-300/80 whitespace-pre-wrap break-all leading-relaxed">
                                {payloadPretty(msg.payload)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {loading && (
        <div className="text-gray-500 text-center mt-8 text-sm">Searching…</div>
      )}
    </div>
  );
}
