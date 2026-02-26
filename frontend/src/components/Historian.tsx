"use client";

import { useState } from 'react';

interface HistorianMessage {
  id: string;
  device_eui: string;
  topic: string;
  direction: string;
  payload: unknown;
  received_at: string;
}

export default function Historian() {
  const [deviceEui, setDeviceEui] = useState('');
  const [direction, setDirection] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [results, setResults] = useState<HistorianMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  const search = async (newOffset = 0) => {
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams();
      if (deviceEui) params.set('device_eui', deviceEui);
      if (direction !== 'all') params.set('direction', direction);
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      params.set('limit', String(limit));
      params.set('offset', String(newOffset));

      const res = await fetch(`${apiUrl}/api/messages?${params}`);
      const data = await res.json();
      const totalCount = parseInt(res.headers.get('X-Total-Count') || '0', 10);
      setResults(data);
      setTotal(totalCount);
      setOffset(newOffset);
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

  const truncate = (s: unknown, max = 80) => {
    const str = typeof s === 'string' ? s : JSON.stringify(s);
    return str.length > max ? str.slice(0, max) + '…' : str;
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="h-full overflow-auto p-4">
      {/* Search form */}
      <form onSubmit={handleSubmit} className="bg-[#252526] rounded border border-[#333] p-4 mb-4">
        <h2 className="text-xs font-semibold text-yellow-400 uppercase mb-3">Message History Search</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <div>
            <label className="block text-[10px] text-gray-500 mb-1">DevEUI</label>
            <input
              type="text"
              value={deviceEui}
              onChange={e => setDeviceEui(e.target.value)}
              placeholder="e.g. 8C1F64…"
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none font-mono"
            />
          </div>
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
          <div>
            <label className="block text-[10px] text-gray-500 mb-1">From</label>
            <input
              type="datetime-local"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-1">To</label>
            <input
              type="datetime-local"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
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
              {total === 0 ? 'No results' : `${total} result${total !== 1 ? 's' : ''} · page ${currentPage} of ${totalPages}`}
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
                    <th className="px-3 py-2 text-left">Received At</th>
                    <th className="px-3 py-2 text-left">DevEUI</th>
                    <th className="px-3 py-2 text-left">Direction</th>
                    <th className="px-3 py-2 text-left">Topic</th>
                    <th className="px-3 py-2 text-left">Payload</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(msg => (
                    <tr key={msg.id} className="border-b border-[#2a2a2a] hover:bg-[#252526] transition-colors">
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
                      <td className="px-3 py-2 font-mono text-gray-500 text-[10px] max-w-[300px] truncate" title={msg.payload}>
                        {truncate(msg.payload)}
                      </td>
                    </tr>
                  ))}
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
