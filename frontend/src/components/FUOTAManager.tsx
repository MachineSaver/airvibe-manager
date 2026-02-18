'use client';

import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FuotaState =
  | 'idle'
  | 'initializing'
  | 'waiting_ack'
  | 'sending_blocks'
  | 'verifying'
  | 'resending'
  | 'complete'
  | 'failed'
  | 'aborted';

interface FirmwareInfo {
  sessionId: string;
  name: string;
  size: number;
  totalBlocks: number;
  initPayloadHex: string;
}

interface DeviceProgress {
  devEui: string;
  state: FuotaState;
  blocksSent: number;
  totalBlocks: number;
  verifyAttempts: number;
  lastMissedCount: number;
  error: string | null;
  firmwareName?: string;
  firmwareSize?: number;
}

interface Device {
  dev_eui: string;
  last_seen: string;
  uplink_count: number;
}

interface Props {
  socket: Socket | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<FuotaState, string> = {
  idle: 'Idle',
  initializing: 'Initializing',
  waiting_ack: 'Waiting for ACK',
  sending_blocks: 'Sending Blocks',
  verifying: 'Verifying',
  resending: 'Resending Missed',
  complete: 'Complete',
  failed: 'Failed',
  aborted: 'Aborted',
};

function stateBadgeClass(state: FuotaState): string {
  switch (state) {
    case 'complete':
      return 'bg-green-900/50 border-green-600 text-green-400';
    case 'sending_blocks':
    case 'initializing':
    case 'waiting_ack':
      return 'bg-blue-900/50 border-blue-600 text-blue-300';
    case 'verifying':
    case 'resending':
      return 'bg-yellow-900/50 border-yellow-600 text-yellow-300';
    case 'failed':
    case 'aborted':
      return 'bg-red-900/50 border-red-600 text-red-400';
    default:
      return 'bg-[#333] border-[#444] text-gray-400';
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FUOTAManager({ socket }: Props) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [firmwareInfo, setFirmwareInfo] = useState<FirmwareInfo | null>(null);
  const [uploadErr, setUploadErr] = useState('');
  const [uploading, setUploading] = useState(false);

  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [selectedDevEuis, setSelectedDevEuis] = useState<Set<string>>(new Set());

  const [deviceProgress, setDeviceProgress] = useState<Record<string, DeviceProgress>>({});
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState('');

  // -------------------------------------------------------------------------
  // Load devices
  // -------------------------------------------------------------------------

  useEffect(() => {
    setDevicesLoading(true);
    fetch(`${apiUrl}/api/devices`)
      .then(r => r.json())
      .then((data: Device[]) => setDevices(data))
      .catch(() => setDevices([]))
      .finally(() => setDevicesLoading(false));
  }, [apiUrl]);

  // -------------------------------------------------------------------------
  // Socket.io — FUOTA progress events
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!socket) return;
    const handler = (progress: DeviceProgress) => {
      setDeviceProgress(prev => ({ ...prev, [progress.devEui]: progress }));
    };
    socket.on('fuota:progress', handler);
    return () => { socket.off('fuota:progress', handler); };
  }, [socket]);

  // -------------------------------------------------------------------------
  // Firmware upload
  // -------------------------------------------------------------------------

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadErr('');
    setUploading(true);
    try {
      const buf = await f.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), '')
      );
      const res = await fetch(`${apiUrl}/api/fuota/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name, data: base64 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      setFirmwareInfo({ ...json, name: f.name });
      setDeviceProgress({});
    } catch (err: unknown) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function handleReset() {
    setFirmwareInfo(null);
    setUploadErr('');
    setDeviceProgress({});
    setSelectedDevEuis(new Set());
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // -------------------------------------------------------------------------
  // Device selection
  // -------------------------------------------------------------------------

  function toggleDevice(devEui: string) {
    setSelectedDevEuis(prev => {
      const next = new Set(prev);
      if (next.has(devEui)) { next.delete(devEui); } else { next.add(devEui); }
      return next;
    });
  }

  function selectAll() { setSelectedDevEuis(new Set(devices.map(d => d.dev_eui))); }
  function deselectAll() { setSelectedDevEuis(new Set()); }

  // -------------------------------------------------------------------------
  // Start FUOTA
  // -------------------------------------------------------------------------

  async function handleStart() {
    if (!firmwareInfo || selectedDevEuis.size === 0) return;
    setStartErr('');
    setStarting(true);
    // Initialise progress cards immediately
    const initial: Record<string, DeviceProgress> = {};
    for (const devEui of selectedDevEuis) {
      initial[devEui] = {
        devEui,
        state: 'initializing',
        blocksSent: 0,
        totalBlocks: firmwareInfo.totalBlocks,
        verifyAttempts: 0,
        lastMissedCount: 0,
        error: null,
        firmwareName: firmwareInfo.name,
        firmwareSize: firmwareInfo.size,
      };
    }
    setDeviceProgress(initial);
    try {
      const res = await fetch(`${apiUrl}/api/fuota/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: firmwareInfo.sessionId, devEuis: [...selectedDevEuis] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Start failed');
      if (json.errors?.length) {
        setStartErr(`Some devices failed to start: ${json.errors.map((e: { devEui: string; error: string }) => `${e.devEui}: ${e.error}`).join(', ')}`);
      }
    } catch (err: unknown) {
      setStartErr(err instanceof Error ? err.message : 'Start failed');
    } finally {
      setStarting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Abort
  // -------------------------------------------------------------------------

  async function handleAbort(devEui: string) {
    await fetch(`${apiUrl}/api/fuota/abort/${devEui}`, { method: 'POST' });
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const hasActiveSession = Object.values(deviceProgress).some(
    p => p.state !== 'complete' && p.state !== 'failed' && p.state !== 'aborted' && p.state !== 'idle'
  );

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">

      {/* ------------------------------------------------------------------ */}
      {/* Section 1 — Firmware Upload                                         */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[#333] bg-[#252526] p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">Firmware Binary</h2>

        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin,application/octet-stream"
            disabled={uploading || hasActiveSession}
            className="block w-full text-sm text-gray-400
              file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0
              file:text-sm file:font-medium file:bg-[#3c3c3c] file:text-gray-200
              hover:file:bg-[#4e4e4e] file:cursor-pointer file:transition-colors
              disabled:opacity-50"
            onChange={handleFileChange}
          />
          {firmwareInfo && (
            <button
              onClick={handleReset}
              disabled={hasActiveSession}
              className="px-3 py-1.5 rounded text-xs bg-[#3c3c3c] hover:bg-[#4e4e4e] text-gray-300 disabled:opacity-40"
            >
              Reset
            </button>
          )}
        </div>

        {uploading && <p className="text-xs text-blue-400">Uploading…</p>}
        {uploadErr && <p className="text-xs text-red-400">{uploadErr}</p>}

        {firmwareInfo && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-gray-500 mb-0.5">File</div>
              <div className="font-mono text-gray-300 break-all">{firmwareInfo.name}</div>
            </div>
            <div>
              <div className="text-gray-500 mb-0.5">Size</div>
              <div className="font-mono text-gray-300">{formatBytes(firmwareInfo.size)}</div>
            </div>
            <div>
              <div className="text-gray-500 mb-0.5">Total Blocks</div>
              <div className="font-mono text-gray-300">{firmwareInfo.totalBlocks.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-gray-500 mb-0.5">Init Payload (Port 22)</div>
              <div className="font-mono text-gray-300 break-all">0x{firmwareInfo.initPayloadHex}</div>
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2 — Device Selector                                         */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[#333] bg-[#252526] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">
            Target Devices
            {selectedDevEuis.size > 0 && (
              <span className="ml-2 text-xs text-blue-400 font-normal">
                {selectedDevEuis.size} selected
              </span>
            )}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              disabled={devices.length === 0 || hasActiveSession}
              className="text-xs px-2 py-1 rounded bg-[#3c3c3c] hover:bg-[#4e4e4e] text-gray-300 disabled:opacity-40"
            >
              All
            </button>
            <button
              onClick={deselectAll}
              disabled={selectedDevEuis.size === 0 || hasActiveSession}
              className="text-xs px-2 py-1 rounded bg-[#3c3c3c] hover:bg-[#4e4e4e] text-gray-300 disabled:opacity-40"
            >
              None
            </button>
          </div>
        </div>

        {devicesLoading && <p className="text-xs text-gray-500">Loading devices…</p>}
        {!devicesLoading && devices.length === 0 && (
          <p className="text-xs text-gray-500">No devices found. Devices appear here once they send an uplink.</p>
        )}

        {!devicesLoading && devices.length > 0 && (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {devices.map(device => (
              <label
                key={device.dev_eui}
                className="flex items-center gap-3 px-2 py-1.5 rounded cursor-pointer hover:bg-[#2d2d2d]"
              >
                <input
                  type="checkbox"
                  checked={selectedDevEuis.has(device.dev_eui)}
                  onChange={() => toggleDevice(device.dev_eui)}
                  disabled={hasActiveSession}
                  className="accent-blue-500"
                />
                <span className="font-mono text-xs text-gray-300 flex-1">{device.dev_eui}</span>
                <span className="text-xs text-gray-500">
                  last seen {formatDate(device.last_seen)}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 3 — Start + Progress                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[#333] bg-[#252526] p-4 space-y-3">
        <div className="flex items-center gap-3">
          <button
            onClick={handleStart}
            disabled={!firmwareInfo || selectedDevEuis.size === 0 || starting || hasActiveSession}
            className="px-4 py-2 rounded text-sm font-medium bg-amber-600 hover:bg-amber-500
              text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {starting ? 'Starting…' : 'Start FUOTA Update'}
          </button>
          {hasActiveSession && (
            <span className="text-xs text-yellow-400">Update in progress — reset firmware or wait for completion to start a new session</span>
          )}
        </div>

        {startErr && <p className="text-xs text-red-400">{startErr}</p>}

        {Object.keys(deviceProgress).length === 0 && !hasActiveSession && firmwareInfo && (
          <p className="text-xs text-gray-500">Select devices above and click Start FUOTA Update.</p>
        )}

        {/* Per-device progress cards */}
        <div className="space-y-3">
          {Object.values(deviceProgress).map(p => (
            <DeviceProgressCard
              key={p.devEui}
              progress={p}
              onAbort={() => handleAbort(p.devEui)}
            />
          ))}
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// DeviceProgressCard
// ---------------------------------------------------------------------------

function DeviceProgressCard({
  progress,
  onAbort,
}: {
  progress: DeviceProgress;
  onAbort: () => void;
}) {
  const { devEui, state, blocksSent, totalBlocks, verifyAttempts, lastMissedCount, error } = progress;
  const pct = totalBlocks > 0 ? Math.min(100, Math.round((blocksSent / totalBlocks) * 100)) : 0;
  const isTerminal = state === 'complete' || state === 'failed' || state === 'aborted';
  const isActive = !isTerminal && state !== 'idle';

  return (
    <div className="rounded border border-[#3a3a3a] bg-[#1e1e1e] p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-gray-300">{devEui}</span>
        <div className="flex items-center gap-2">
          <span className={`text-xs border rounded px-2 py-0.5 ${stateBadgeClass(state)}`}>
            {STATE_LABELS[state] ?? state}
          </span>
          {isActive && (
            <button
              onClick={onAbort}
              className="text-xs px-2 py-0.5 rounded border border-red-700 text-red-400 hover:bg-red-900/30"
            >
              Abort
            </button>
          )}
        </div>
      </div>

      {/* Progress bar — shown during block sending */}
      {(state === 'sending_blocks' || state === 'resending' || (isTerminal && totalBlocks > 0)) && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>Blocks {blocksSent.toLocaleString()} / {totalBlocks.toLocaleString()}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-[#333] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${state === 'complete' ? 'bg-green-500' : state === 'failed' || state === 'aborted' ? 'bg-red-500' : 'bg-blue-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="flex gap-4 text-xs text-gray-500">
        {verifyAttempts > 0 && (
          <span>Verify attempts: <span className="text-gray-300">{verifyAttempts}</span></span>
        )}
        {lastMissedCount > 0 && state !== 'complete' && (
          <span>Last missed: <span className="text-yellow-400">{lastMissedCount}</span></span>
        )}
        {state === 'waiting_ack' && (
          <span className="text-blue-400">Waiting for device 0x10 ACK (Class C switch)…</span>
        )}
        {state === 'verifying' && (
          <span className="text-yellow-400">Waiting for 0x11 verification uplink…</span>
        )}
        {state === 'complete' && (
          <span className="text-green-400">Device confirmed all blocks received — applying update</span>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-400 font-mono break-all">{error}</p>
      )}
    </div>
  );
}
