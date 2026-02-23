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
  lastMissedBlocks?: number[];
  error: string | null;
  firmwareName?: string;
  firmwareSize?: number;
  blockIntervalMs?: number;
  classCConfigured?: boolean;
}

interface Device {
  dev_eui: string;
  last_seen: string;
  uplink_count: number;
}

interface DbSession {
  id: string;
  device_eui: string;
  firmware_name: string;
  firmware_size: number;
  total_blocks: number;
  blocks_sent: number;
  status: string;
  verify_attempts: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

interface Props {
  socket: Socket | null;
}

// ---------------------------------------------------------------------------
// Firmware Catalog
// ---------------------------------------------------------------------------

const FIRMWARE_CATALOG = [
  {
    id: 'tpm-868',
    label: 'TPM 868 MHz',
    region: 'EU868',
    description: 'European — Power & Transmission Module',
    filename: 'TPMfw_2-35_Upgrade_Common_868.bin',
    defaultIntervalMs: 10000,
  },
  {
    id: 'tpm-915',
    label: 'TPM 915 MHz',
    region: 'US915',
    description: 'North American — Power & Transmission Module',
    filename: 'TPMfw_2-35_Upgrade_Common_915.bin',
    defaultIntervalMs: 2000,
  },
  {
    id: 'vsm',
    label: 'VSM Universal',
    region: 'All regions',
    description: 'Vibration Sensor Module',
    filename: 'VSMfw_1-27Upgrade_Common.bin',
    defaultIntervalMs: 10000,
  },
] as const;

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

function stateBadgeClass(state: FuotaState | string): string {
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

function isTerminalState(state: FuotaState | string): boolean {
  return state === 'complete' || state === 'failed' || state === 'aborted';
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

function formatEta(totalBlocks: number, blockIntervalMs: number): string {
  const totalMs = totalBlocks * blockIntervalMs;
  const totalSec = Math.round(totalMs / 1000);
  if (totalSec < 60) return `~${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

function formatRemainingEta(remaining: number, blockIntervalMs: number): string {
  return formatEta(remaining, blockIntervalMs);
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
  const [catalogLoading, setCatalogLoading] = useState('');

  const [blockIntervalMs, setBlockIntervalMs] = useState(10000);

  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [selectedDevEuis, setSelectedDevEuis] = useState<Set<string>>(new Set());

  const [deviceProgress, setDeviceProgress] = useState<Record<string, DeviceProgress>>({});
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState('');

  const [sessionHistory, setSessionHistory] = useState<DbSession[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  const [networkServerConfigured, setNetworkServerConfigured] = useState<boolean | null>(null);

  // Derived: set of devEuis with an active (non-terminal, non-idle) session
  const activeDevEuis = new Set(
    Object.values(deviceProgress)
      .filter(p => !isTerminalState(p.state) && p.state !== 'idle')
      .map(p => p.devEui)
  );

  // -------------------------------------------------------------------------
  // Load devices, ThingPark status, and restore session state on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    setDevicesLoading(true);
    fetch(`${apiUrl}/api/devices`)
      .then(r => r.json())
      .then((data: Device[]) => setDevices(data))
      .catch(() => setDevices([]))
      .finally(() => setDevicesLoading(false));
  }, [apiUrl]);

  useEffect(() => {
    fetch(`${apiUrl}/api/fuota/network-server-status`)
      .then(r => r.json())
      .then(json => setNetworkServerConfigured(!!json.configured))
      .catch(() => setNetworkServerConfigured(false));
  }, [apiUrl]);

  useEffect(() => {
    fetch(`${apiUrl}/api/fuota/sessions`)
      .then(r => r.json())
      .then(({ active, sessions }: { active: DeviceProgress[]; sessions: DbSession[] }) => {
        if (active.length > 0) {
          const restored: Record<string, DeviceProgress> = {};
          for (const s of active) restored[s.devEui] = s;
          setDeviceProgress(restored);
        }
        setSessionHistory((sessions as DbSession[]).slice(0, 20));
      })
      .catch(() => {});
  }, [apiUrl]);

  // -------------------------------------------------------------------------
  // Socket.io — FUOTA progress events
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!socket) return;
    const handler = (progress: DeviceProgress) => {
      setDeviceProgress(prev => ({ ...prev, [progress.devEui]: progress }));
      // Update session history when a session goes terminal
      if (isTerminalState(progress.state)) {
        fetch(`${apiUrl}/api/fuota/sessions`)
          .then(r => r.json())
          .then(({ sessions }: { sessions: DbSession[] }) => setSessionHistory(sessions.slice(0, 20)))
          .catch(() => {});
      }
    };
    socket.on('fuota:progress', handler);
    return () => { socket.off('fuota:progress', handler); };
  }, [socket, apiUrl]);

  // -------------------------------------------------------------------------
  // Firmware catalog quick-select
  // -------------------------------------------------------------------------

  async function handleCatalogSelect(entry: typeof FIRMWARE_CATALOG[number]) {
    setUploadErr('');
    setCatalogLoading(entry.id);
    try {
      const res = await fetch(`/assets/firmware/${entry.filename}`);
      if (!res.ok) throw new Error(`Could not load ${entry.filename} (${res.status})`);
      const buf = await res.arrayBuffer();
      const base64 = btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ''));
      const uploadRes = await fetch(`${apiUrl}/api/fuota/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: entry.filename, data: base64 }),
      });
      const json = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(json.error || 'Upload failed');
      setFirmwareInfo({ ...json, name: entry.filename });
      setBlockIntervalMs(entry.defaultIntervalMs);
    } catch (err: unknown) {
      setUploadErr(err instanceof Error ? err.message : 'Failed to load firmware');
    } finally {
      setCatalogLoading('');
    }
  }

  // -------------------------------------------------------------------------
  // Firmware upload (manual)
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
    } catch (err: unknown) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function handleReset() {
    setFirmwareInfo(null);
    setUploadErr('');
    setSelectedDevEuis(new Set());
    setBlockIntervalMs(10000);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // -------------------------------------------------------------------------
  // Device selection
  // -------------------------------------------------------------------------

  function toggleDevice(devEui: string) {
    if (activeDevEuis.has(devEui)) return; // can't toggle an active device
    setSelectedDevEuis(prev => {
      const next = new Set(prev);
      if (next.has(devEui)) { next.delete(devEui); } else { next.add(devEui); }
      return next;
    });
  }

  function selectAll() {
    setSelectedDevEuis(new Set(devices.filter(d => !activeDevEuis.has(d.dev_eui)).map(d => d.dev_eui)));
  }
  function deselectAll() { setSelectedDevEuis(new Set()); }

  // -------------------------------------------------------------------------
  // Start FUOTA
  // -------------------------------------------------------------------------

  // Only start for selected devices that aren't already active
  const eligibleSelected = [...selectedDevEuis].filter(e => !activeDevEuis.has(e));

  async function handleStart() {
    if (!firmwareInfo || eligibleSelected.length === 0) return;
    setStartErr('');
    setStarting(true);
    // Initialise progress cards immediately for visual feedback
    setDeviceProgress(prev => {
      const next = { ...prev };
      for (const devEui of eligibleSelected) {
        next[devEui] = {
          devEui,
          state: 'initializing',
          blocksSent: 0,
          totalBlocks: firmwareInfo.totalBlocks,
          verifyAttempts: 0,
          lastMissedCount: 0,
          error: null,
          firmwareName: firmwareInfo.name,
          firmwareSize: firmwareInfo.size,
          blockIntervalMs,
          classCConfigured: false,
        };
      }
      return next;
    });
    try {
      const res = await fetch(`${apiUrl}/api/fuota/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: firmwareInfo.sessionId,
          devEuis: eligibleSelected,
          blockIntervalMs,
        }),
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

  const showIntervalWarning = blockIntervalMs < 2000;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">

      {/* ------------------------------------------------------------------ */}
      {/* Section A — Class C Status Banner                                   */}
      {/* ------------------------------------------------------------------ */}
      {networkServerConfigured === true && (
        <div className="rounded-lg border border-green-700 bg-green-900/20 px-4 py-3 text-xs text-green-300">
          <span className="font-semibold">ChirpStack Class C auto-switch enabled</span>
          {' '}— device class will be updated automatically before each FUOTA session and restored on completion.
        </div>
      )}
      {networkServerConfigured === false && (
        <div className="rounded-lg border border-amber-700 bg-amber-900/20 px-4 py-3 text-xs text-amber-300">
          <span className="font-semibold">ChirpStack API key not configured.</span>
          {' '}Set <code className="font-mono">CHIRPSTACK_API_KEY</code> in <code className="font-mono">.env</code> to enable automatic Class A→C switching.
          Without this, <strong>manually set the device class to Class C</strong> in the ChirpStack web UI before each FUOTA session.
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Section B — Firmware Selection                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[#333] bg-[#252526] p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">Firmware Selection</h2>

        {/* Catalog quick-select */}
        <div className="flex flex-wrap gap-2">
          {FIRMWARE_CATALOG.map(entry => (
            <button
              key={entry.id}
              onClick={() => handleCatalogSelect(entry)}
              disabled={catalogLoading === entry.id || !!uploading}
              className={`flex items-center gap-2 px-3 py-2 rounded border text-xs font-medium transition-colors
                ${firmwareInfo?.name === entry.filename
                  ? 'border-blue-500 bg-blue-900/30 text-blue-300'
                  : 'border-[#444] bg-[#3c3c3c] hover:bg-[#4e4e4e] text-gray-300'}
                disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <span>{entry.label}</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#222] border border-[#555] text-gray-400">
                {entry.region}
              </span>
              {catalogLoading === entry.id && (
                <span className="text-blue-400">…</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs text-gray-500">
          <div className="flex-1 border-t border-[#333]" />
          <span>or upload custom binary</span>
          <div className="flex-1 border-t border-[#333]" />
        </div>

        {/* File input */}
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin,application/octet-stream"
            disabled={uploading || !!catalogLoading}
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
              className="px-3 py-1.5 rounded text-xs bg-[#3c3c3c] hover:bg-[#4e4e4e] text-gray-300"
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
      {/* Section C — Send Configuration                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[#333] bg-[#252526] p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">Send Configuration</h2>

        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 whitespace-nowrap">Block interval (ms)</label>
            <input
              type="number"
              min={1000}
              max={60000}
              step={500}
              value={blockIntervalMs}
              onChange={e => setBlockIntervalMs(Math.min(60000, Math.max(1000, parseInt(e.target.value) || 1000)))}
              className="w-24 px-2 py-1 rounded border border-[#444] bg-[#3c3c3c] text-xs text-gray-200 font-mono focus:outline-none focus:border-blue-500"
            />
          </div>
          {firmwareInfo && (
            <div className="text-xs text-gray-400">
              ETA: <span className="text-gray-200 font-mono">{formatEta(firmwareInfo.totalBlocks, blockIntervalMs)}</span>
              {' '}for <span className="text-gray-300">{firmwareInfo.totalBlocks.toLocaleString()} blocks</span>
            </div>
          )}
        </div>

        {showIntervalWarning && (
          <p className="text-xs text-amber-400">
            Low interval — safe only on US915 with Class C profile confirmed. EU868 requires ≥5,000ms at DR3; use ≥10,000ms to be safe.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section D — Target Devices                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[#333] bg-[#252526] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">
            Target Devices
            {selectedDevEuis.size > 0 && (
              <span className="ml-2 text-xs text-blue-400 font-normal">
                {eligibleSelected.length} selected
              </span>
            )}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              disabled={devices.length === 0}
              className="text-xs px-2 py-1 rounded bg-[#3c3c3c] hover:bg-[#4e4e4e] text-gray-300 disabled:opacity-40"
            >
              All
            </button>
            <button
              onClick={deselectAll}
              disabled={selectedDevEuis.size === 0}
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
            {devices.map(device => {
              const isActive = activeDevEuis.has(device.dev_eui);
              return (
                <div
                  key={device.dev_eui}
                  className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-[#2d2d2d]"
                >
                  {isActive ? (
                    <span className="px-2 py-0.5 rounded text-xs bg-amber-900/50 border border-amber-600 text-amber-300">
                      Updating…
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={selectedDevEuis.has(device.dev_eui)}
                      onChange={() => toggleDevice(device.dev_eui)}
                      className="accent-blue-500 cursor-pointer"
                    />
                  )}
                  <span className="font-mono text-xs text-gray-300 flex-1">{device.dev_eui}</span>
                  <span className="text-xs text-gray-500">
                    last seen {formatDate(device.last_seen)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Start button */}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={handleStart}
            disabled={!firmwareInfo || eligibleSelected.length === 0 || starting}
            className="px-4 py-2 rounded text-sm font-medium bg-amber-600 hover:bg-amber-500
              text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {starting ? 'Starting…' : 'Start FUOTA Update'}
          </button>
          {!firmwareInfo && (
            <span className="text-xs text-gray-500">Select firmware above first</span>
          )}
          {firmwareInfo && eligibleSelected.length === 0 && activeDevEuis.size === 0 && (
            <span className="text-xs text-gray-500">Select target devices above</span>
          )}
        </div>

        {startErr && <p className="text-xs text-red-400">{startErr}</p>}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section E — Active Jobs + Session History                           */}
      {/* ------------------------------------------------------------------ */}
      {Object.keys(deviceProgress).length > 0 && (
        <div className="rounded-lg border border-[#333] bg-[#252526] p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-200">Active Jobs</h2>
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
      )}

      {sessionHistory.length > 0 && (
        <div className="rounded-lg border border-[#333] bg-[#252526] p-4 space-y-2">
          <button
            className="flex items-center gap-2 w-full text-left"
            onClick={() => setHistoryExpanded(v => !v)}
          >
            <span className="text-sm font-semibold text-gray-200">Session History</span>
            <span className="text-xs text-gray-500">({sessionHistory.length})</span>
            <span className="ml-auto text-xs text-gray-500">{historyExpanded ? '▲ collapse' : '▼ expand'}</span>
          </button>
          {historyExpanded && (
            <div className="space-y-2 mt-2">
              {sessionHistory.map(s => (
                <SessionHistoryCard key={s.id} session={s} />
              ))}
            </div>
          )}
        </div>
      )}

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
  const {
    devEui, state, blocksSent, totalBlocks, verifyAttempts,
    lastMissedCount, lastMissedBlocks, error, firmwareName, blockIntervalMs, classCConfigured,
  } = progress;
  const pct = totalBlocks > 0 ? Math.min(100, Math.round((blocksSent / totalBlocks) * 100)) : 0;
  const isTerminal = isTerminalState(state);
  const isActive = !isTerminal && state !== 'idle';

  const STEPS: { key: FuotaState; label: string }[] = [
    { key: 'waiting_ack', label: 'Init' },
    { key: 'sending_blocks', label: 'Blocks' },
    { key: 'verifying', label: 'Verify' },
    { key: 'complete', label: 'Done' },
  ];
  const stepOrder: FuotaState[] = ['initializing', 'waiting_ack', 'sending_blocks', 'resending', 'verifying', 'complete'];
  const currentStepIndex = stepOrder.indexOf(state);

  return (
    <div className="rounded border border-[#3a3a3a] bg-[#1e1e1e] p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-gray-300">{devEui}</span>
          {firmwareName && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[#333] border border-[#444] text-gray-400">
              {firmwareName}
            </span>
          )}
          {classCConfigured === true && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/40 border border-green-700 text-green-400">
              Class C ✓
            </span>
          )}
          {classCConfigured === false && isActive && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 border border-amber-700 text-amber-400">
              Class A mode
            </span>
          )}
        </div>
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

      {/* Step indicator */}
      {(isActive || isTerminal) && (
        <div className="flex items-center gap-1 text-xs">
          {STEPS.map((step, idx) => {
            const stepIdx = stepOrder.indexOf(step.key);
            const isCurrentOrPast = currentStepIndex >= stepIdx;
            const isCurrent = state === step.key || (step.key === 'sending_blocks' && state === 'resending');
            return (
              <div key={step.key} className="flex items-center gap-1">
                {idx > 0 && <div className={`w-4 h-px ${isCurrentOrPast ? 'bg-blue-500' : 'bg-[#444]'}`} />}
                <span className={`px-1.5 py-0.5 rounded transition-colors ${
                  isCurrent
                    ? 'bg-blue-900/50 border border-blue-500 text-blue-300'
                    : isCurrentOrPast || isTerminal
                    ? 'text-gray-400'
                    : 'text-gray-600'
                }`}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Progress bar */}
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
      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        {verifyAttempts > 0 && (
          <span>Verify attempts: <span className="text-gray-300">{verifyAttempts}</span></span>
        )}
        {lastMissedCount > 0 && state !== 'complete' && (
          <span>Last missed: <span className="text-yellow-400">{lastMissedCount}</span></span>
        )}
        {state === 'sending_blocks' && blockIntervalMs && totalBlocks > 0 && (
          <span>
            ETA: <span className="text-gray-300 font-mono">
              {formatRemainingEta(totalBlocks - blocksSent, blockIntervalMs)}
            </span>
            {' '}remaining
          </span>
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

      {/* Missed blocks map — shown during resending or after a verify with missed blocks */}
      {lastMissedBlocks && lastMissedBlocks.length > 0 && totalBlocks > 0 && state !== 'complete' && (
        <MissedBlocksMap totalBlocks={totalBlocks} missedBlocks={lastMissedBlocks} />
      )}

      {error && (
        <p className="text-xs text-red-400 font-mono break-all">{error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MissedBlocksMap
// ---------------------------------------------------------------------------

const MAP_CELLS = 200; // fixed visual resolution regardless of firmware size

function MissedBlocksMap({
  totalBlocks,
  missedBlocks,
}: {
  totalBlocks: number;
  missedBlocks: number[];
}) {
  const missedSet = new Set(missedBlocks);
  const cellCount = Math.min(totalBlocks, MAP_CELLS);
  // Each cell covers a contiguous range of blocks
  const cells = Array.from({ length: cellCount }, (_, i) => {
    const lo = Math.floor((i * totalBlocks) / cellCount);
    const hi = Math.floor(((i + 1) * totalBlocks) / cellCount);
    // Cell is "missed" if any block in [lo, hi) is in the missed set
    let hasMissed = false;
    for (let b = lo; b < hi; b++) {
      if (missedSet.has(b)) { hasMissed = true; break; }
    }
    return { lo, hi: hi - 1, hasMissed };
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span className="font-medium text-amber-400">
          Missed blocks from last 0x11 uplink
        </span>
        <span>
          <span className="text-amber-400 font-mono">{missedBlocks.length}</span>
          <span> block{missedBlocks.length !== 1 ? 's' : ''} to resend</span>
        </span>
      </div>

      {/* Block map grid */}
      <div
        className="flex flex-wrap gap-px rounded overflow-hidden"
        title={`${missedBlocks.length} missed block(s): ${missedBlocks.slice(0, 12).join(', ')}${missedBlocks.length > 12 ? '…' : ''}`}
      >
        {cells.map((cell, i) => (
          <div
            key={i}
            title={
              cell.lo === cell.hi
                ? `Block ${cell.lo}${cell.hasMissed ? ' — MISSING' : ' — received'}`
                : `Blocks ${cell.lo}–${cell.hi}${cell.hasMissed ? ' — contains missing' : ' — received'}`
            }
            className={`h-3 flex-shrink-0 rounded-sm transition-colors ${
              cell.hasMissed
                ? 'bg-amber-500'
                : 'bg-blue-900/60'
            }`}
            style={{ width: `${Math.max(2, Math.floor(100 / cellCount))}%` }}
          />
        ))}
      </div>

      {/* Block number list */}
      <div className="flex flex-wrap gap-1">
        {missedBlocks.map(b => (
          <span
            key={b}
            className="font-mono text-[10px] px-1 py-0.5 rounded bg-amber-900/40 border border-amber-700/50 text-amber-300"
          >
            {b}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-3 text-[10px] text-gray-600">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500" /> missing
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-900/60 border border-blue-800" /> received
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionHistoryCard
// ---------------------------------------------------------------------------

function SessionHistoryCard({ session }: { session: DbSession }) {
  const pct = session.total_blocks > 0
    ? Math.min(100, Math.round((session.blocks_sent / session.total_blocks) * 100))
    : 0;

  return (
    <div className="rounded border border-[#3a3a3a] bg-[#1e1e1e] p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-gray-400">{session.device_eui}</span>
          <span className="text-xs text-gray-500">{session.firmware_name}</span>
        </div>
        <span className={`text-xs border rounded px-2 py-0.5 ${stateBadgeClass(session.status as FuotaState)}`}>
          {session.status}
        </span>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span>Blocks: <span className="text-gray-400">{session.blocks_sent}/{session.total_blocks}</span> ({pct}%)</span>
        {session.verify_attempts > 0 && (
          <span>Verify: <span className="text-gray-400">{session.verify_attempts}</span></span>
        )}
        <span>Started: <span className="text-gray-400">{formatDate(session.started_at)}</span></span>
        {session.completed_at && (
          <span>Ended: <span className="text-gray-400">{formatDate(session.completed_at)}</span></span>
        )}
      </div>
      {session.error && (
        <p className="text-xs text-red-400 font-mono break-all">{session.error}</p>
      )}
    </div>
  );
}
