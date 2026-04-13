'use client';

import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FuotaState =
  | 'idle'
  | 'config_poll'
  | 'initializing'
  | 'waiting_ack'
  | 'sending_blocks'
  | 'verifying'
  | 'resending'
  | 'flashing'
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
  startedAt?: number;
  blocksSentAtStart?: number;
  blocksResentSoFar?: number;
  confirmedRanges?: [number, number][];
  configCheckDone?: boolean;
  configPollAttempt?: number;
  classAOnly?: boolean;
}

interface Device {
  dev_eui: string;
  last_seen: string;
  uplink_count: number;
  metadata?: {
    tpm_fw?: string;
    vsm_fw?: string;
    push_period_min?: number;
    config_updated_at?: string;
    ism_band?: string;
  };
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
// ISM Band options
// ---------------------------------------------------------------------------

const ISM_BAND_OPTIONS = [
  { value: 'EU868', label: 'EU868 — Europe (ETSI, 863–870 MHz)' },
  { value: 'US915', label: 'US915 — N. America (FCC, 902–928 MHz)' },
  { value: 'AU915', label: 'AU915 — Australia (FCC, 915–928 MHz)' },
  { value: 'CN470', label: 'CN470 — China (FCC, 470–510 MHz)' },
  { value: 'EU433', label: 'EU433 — Europe 433 MHz (ETSI)' },
] as const;

// ---------------------------------------------------------------------------
// Firmware Catalog
// ---------------------------------------------------------------------------

const FIRMWARE_CATALOG = [
  {
    id: 'tpm-868-235',
    label: 'TPM 868 MHz v2.35',
    region: 'EU868',
    description: 'European — Power & Transmission Module',
    filename: 'TPMfw_2-35_Upgrade_868.bin',
    defaultIntervalMs: 60000,
  },
  {
    id: 'tpm-915-235',
    label: 'TPM 915 MHz v2.35',
    region: 'US915',
    description: 'North American — Power & Transmission Module',
    filename: 'TPMfw_2-35_Upgrade_915.bin',
    defaultIntervalMs: 5000,
  },
  {
    id: 'tpm-868-236',
    label: 'TPM 868 MHz v2.36',
    region: 'EU868',
    description: 'European — Power & Transmission Module',
    filename: 'TPMfw_2-36_Upgrade_868.bin',
    defaultIntervalMs: 60000,
  },
  {
    id: 'tpm-915-236',
    label: 'TPM 915 MHz v2.36',
    region: 'US915',
    description: 'North American — Power & Transmission Module',
    filename: 'TPMfw_2-36_Upgrade_915.bin',
    defaultIntervalMs: 5000,
  },
  {
    id: 'tpm-868-237',
    label: 'TPM 868 MHz v2.37',
    region: 'EU868',
    description: 'European — Power & Transmission Module',
    filename: 'TPMfw_2-37_Upgrade_868.bin',
    defaultIntervalMs: 60000,
  },
  {
    id: 'tpm-915-237',
    label: 'TPM 915 MHz v2.37',
    region: 'US915',
    description: 'North American — Power & Transmission Module',
    filename: 'TPMfw_2-37_Upgrade_915.bin',
    defaultIntervalMs: 5000,
  },
  {
    id: 'vsm-127',
    label: 'VSM Universal v1.27',
    region: 'All regions',
    description: 'Vibration Sensor Module',
    filename: 'VSMfw_1-27_Upgrade.bin',
    defaultIntervalMs: 5000,
  },
  {
    id: 'vsm-128',
    label: 'VSM Universal v1.28',
    region: 'All regions',
    description: 'Vibration Sensor Module',
    filename: 'VSMfw_1-28_Upgrade.bin',
    defaultIntervalMs: 5000,
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/** Mirror of backend isClassAOnly — TPM firmware on EU868 runs in Class A mode. */
function isClassAOnlyFirmware(firmwareName: string, ismBand: string): boolean {
  const name = (firmwareName || '').toUpperCase();
  const band = (ismBand || '').toUpperCase();
  const isTpm   = name.includes('TPM');
  const isEu868 = band.includes('868') || name.includes('868');
  return isTpm && isEu868;
}

function stateBadgeClass(state: FuotaState | string): string {
  switch (state) {
    case 'complete':
      return 'bg-[var(--av-accent)]/10 border-[var(--av-accent)]/40 text-[var(--av-accent)]';
    case 'config_poll':
      return 'bg-[var(--av-accent-purple)]/10 border-[var(--av-accent-purple)]/40 text-[var(--av-accent-purple)]';
    case 'sending_blocks':
    case 'initializing':
    case 'waiting_ack':
      return 'bg-[var(--av-accent-cyan)]/10 border-[var(--av-accent-cyan)]/40 text-[var(--av-accent-cyan)]';
    case 'verifying':
    case 'resending':
      return 'bg-[var(--av-accent-amber)]/10 border-[var(--av-accent-amber)]/40 text-[var(--av-accent-amber)]';
    case 'flashing':
      return 'bg-[var(--av-accent-amber)]/20 border-[var(--av-accent-amber)]/60 text-[var(--av-accent-amber)]';
    case 'failed':
    case 'aborted':
      return 'bg-[var(--av-accent-red)]/10 border-[var(--av-accent-red)]/40 text-[var(--av-accent-red)]';
    default:
      return 'bg-[var(--av-bg-raised)] border-[var(--av-border)] text-[var(--av-text-subtle)]';
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
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    let str = `~${h}h`;
    if (m > 0) str += ` ${m}m`;
    if (s > 0) str += ` ${s}s`;
    return str;
  }
  return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

function formatRemainingEta(remaining: number, blockIntervalMs: number): string {
  return formatEta(remaining, blockIntervalMs);
}

/**
 * ETA using observed throughput when enough blocks have been sent in this
 * session run (≥10), falling back to the configured interval estimate before then.
 *
 * blocksSentAtStart is the blocksSent value at session creation (0 for a new
 * session; row.blocks_sent for a recovered/resumed session). Only blocks sent
 * since session start are counted so that a mid-session resume does not inflate
 * the throughput by attributing pre-existing blocks to the current elapsed time.
 */
function formatObservedEta(
  remaining: number,
  blocksSent: number,
  startedAt: number | undefined,
  blockIntervalMs: number | undefined,
  blocksSentAtStart: number = 0,
): string | null {
  if (remaining <= 0) return null;
  const blocksThisRun = blocksSent - blocksSentAtStart;
  if (startedAt && blocksThisRun >= 10) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 0) {
      const msPerBlock = elapsedMs / blocksThisRun;
      return formatEta(remaining, msPerBlock);
    }
  }
  if (blockIntervalMs) return formatRemainingEta(remaining, blockIntervalMs);
  return null;
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
  const [selectedIsmBand, setSelectedIsmBand] = useState('');

  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [selectedDevEuis, setSelectedDevEuis] = useState<Set<string>>(new Set());

  const [deviceProgress, setDeviceProgress] = useState<Record<string, DeviceProgress>>({});
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState('');

  const [sessionHistory, setSessionHistory] = useState<DbSession[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  const [networkServerStatus, setNetworkServerStatus] = useState<{ configured: boolean; type: string } | null>(null);

  // Derived: set of devEuis with an active (non-terminal, non-idle) session
  const activeDevEuis = new Set(
    Object.values(deviceProgress)
      .filter(p => !isTerminalState(p.state) && p.state !== 'idle')
      .map(p => p.devEui)
  );

  // Filter history: don't show non-terminal DB rows for devices that currently have
  // an in-memory active session (they'd show stale data until the session ends).
  const filteredHistory = sessionHistory.filter(
    s => !(activeDevEuis.has(s.device_eui) && !isTerminalState(s.status as FuotaState))
  );

  // -------------------------------------------------------------------------
  // Load devices, ThingPark status, and restore session state on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    let mounted = true;

    function fetchDevices(initial = false) {
      if (initial) setDevicesLoading(true);
      fetch(`${apiUrl}/api/devices`)
        .then(r => r.json())
        .then((data: Device[]) => {
          if (!mounted) return;
          setDevices(data);
          if (initial) setDevicesLoading(false);
        })
        .catch(() => {
          if (!mounted) return;
          if (initial) { setDevices([]); setDevicesLoading(false); }
        });
    }

    fetchDevices(true);
    // Refresh every 30 s to pick up new firmware version metadata after config responses
    const timer = setInterval(() => fetchDevices(false), 30000);
    return () => { mounted = false; clearInterval(timer); };
  }, [apiUrl]);

  useEffect(() => {
    fetch(`${apiUrl}/api/fuota/network-server-status`)
      .then(r => r.json())
      .then(json => setNetworkServerStatus({ configured: !!json.configured, type: json.type || 'chirpstack' }))
      .catch(() => {});
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

  // Auto-populate ISM band when all selected devices share the same known band
  useEffect(() => {
    if (selectedDevEuis.size === 0) return;
    const bands = new Set(
      [...selectedDevEuis]
        .map(eui => devices.find(d => d.dev_eui === eui)?.metadata?.ism_band)
        .filter((b): b is string => !!b)
    );
    if (bands.size === 1) setSelectedIsmBand([...bands][0]);
  }, [selectedDevEuis, devices]);

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
      const blob = new Blob([buf], { type: 'application/octet-stream' });
      const formData = new FormData();
      formData.append('firmware', blob, entry.filename);
      const uploadRes = await fetch(`${apiUrl}/api/fuota/upload`, {
        method: 'POST',
        body: formData,
        // No Content-Type header — browser sets multipart boundary automatically
      });
      const json = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(json.error || 'Upload failed');
      setFirmwareInfo({ ...json, name: entry.filename });
      setBlockIntervalMs(entry.defaultIntervalMs);
      if (entry.region && entry.region !== 'All regions') setSelectedIsmBand(entry.region);
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
      const formData = new FormData();
      formData.append('firmware', f);
      const res = await fetch(`${apiUrl}/api/fuota/upload`, {
        method: 'POST',
        body: formData,
        // No Content-Type header — browser sets multipart boundary automatically
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
    setSelectedIsmBand('');
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

  // Devices with no known ISM band in metadata — need user to select one manually
  const devicesWithoutBand = eligibleSelected.filter(
    eui => !devices.find(d => d.dev_eui === eui)?.metadata?.ism_band
  );
  const needsBandSelection = devicesWithoutBand.length > 0 && !selectedIsmBand;

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
          startedAt: Date.now(),
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
          ...(selectedIsmBand ? { ismBand: selectedIsmBand } : {}),
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
  // Band-specific interval limits
  // -------------------------------------------------------------------------

  const classAOnlyMode = isClassAOnlyFirmware(firmwareInfo?.name ?? '', selectedIsmBand);
  const minIntervalMs = classAOnlyMode ? 60000 : 5000;
  const maxIntervalMs = 180000;

  // Re-clamp the current interval whenever the limits change (e.g. user switches firmware)
  useEffect(() => {
    setBlockIntervalMs(prev => Math.min(maxIntervalMs, Math.max(minIntervalMs, prev)));
  }, [minIntervalMs, maxIntervalMs]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">

      {/* ------------------------------------------------------------------ */}
      {/* Section A — Class C Status Banner                                   */}
      {/* ------------------------------------------------------------------ */}
      {networkServerStatus?.configured === true && networkServerStatus.type === 'chirpstack' && (
        <div className="rounded-lg border border-green-700 bg-green-900/20 px-4 py-3 text-xs text-green-300">
          <span className="font-semibold">ChirpStack Class C auto-switch enabled</span>
          {' '}— device class will be updated automatically before each FUOTA session and restored on completion.
        </div>
      )}
      {networkServerStatus?.configured === false && networkServerStatus.type === 'chirpstack' && (
        <div className="rounded-lg border border-amber-700 bg-amber-900/20 px-4 py-3 text-xs text-amber-300">
          <span className="font-semibold">ChirpStack API key not configured.</span>
          {' '}Set <code className="font-mono">CHIRPSTACK_API_KEY</code> in <code className="font-mono">.env</code> to enable automatic Class A→C switching.
          Without this, <strong>manually set the device class to Class C</strong> in the ChirpStack web UI before each FUOTA session.
        </div>
      )}
      {networkServerStatus?.configured === true && networkServerStatus.type === 'thingpark' && (
        <div className="rounded-lg border border-green-700 bg-green-900/20 px-4 py-3 text-xs text-green-300">
          <span className="font-semibold">ThingPark Class C auto-switch enabled</span>
          {' '}— device profile will be updated automatically via the DX Core API before each FUOTA session and restored on completion.
        </div>
      )}
      {networkServerStatus?.configured === false && networkServerStatus.type === 'thingpark' && (
        <div className="rounded-lg border border-amber-700 bg-amber-900/20 px-4 py-3 text-xs text-amber-300">
          <span className="font-semibold">ThingPark Class C auto-switch not configured.</span>
          {' '}Set <code className="font-mono">THINGPARK_CLIENT_ID</code> and <code className="font-mono">THINGPARK_CLIENT_SECRET</code> in <code className="font-mono">.env</code> to enable automatic profile switching.
          Without this, <strong>manually set the device profile to Class C</strong> in the ThingPark portal before each FUOTA session.
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Section B — Firmware Selection                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[var(--av-border)] bg-[var(--av-bg-surface)] p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[var(--av-text-primary)]">Firmware Selection</h2>

        {/* Catalog quick-select */}
        <div className="flex flex-wrap gap-2">
          {FIRMWARE_CATALOG.map(entry => (
            <button
              key={entry.id}
              onClick={() => handleCatalogSelect(entry)}
              disabled={catalogLoading === entry.id || !!uploading}
              className={`flex items-center gap-2 px-3 py-2 rounded border text-xs font-medium transition-colors
                ${firmwareInfo?.name === entry.filename
                  ? 'border-[var(--av-accent)]/60 bg-[var(--av-accent)]/10 text-[var(--av-accent)]'
                  : 'border-[var(--av-border)] bg-[var(--av-bg-raised)] hover:bg-[var(--av-bg-hover)] text-[var(--av-text-muted)]'}
                disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <span>{entry.label}</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--av-bg-base)] border border-[var(--av-border)] text-[var(--av-text-subtle)]">
                {entry.region}
              </span>
              {catalogLoading === entry.id && (
                <span className="text-[var(--av-accent-cyan)]">…</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--av-text-subtle)]">
          <div className="flex-1 border-t border-[var(--av-border)]" />
          <span>or upload custom binary</span>
          <div className="flex-1 border-t border-[var(--av-border)]" />
        </div>

        {/* File input */}
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin,application/octet-stream"
            disabled={uploading || !!catalogLoading}
            className="block w-full text-sm text-[var(--av-text-muted)]
              file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0
              file:text-sm file:font-medium file:bg-[var(--av-bg-raised)] file:text-[var(--av-text-primary)]
              hover:file:bg-[var(--av-bg-hover)] file:cursor-pointer file:transition-colors
              disabled:opacity-50"
            onChange={handleFileChange}
          />
          {firmwareInfo && (
            <button
              onClick={handleReset}
              className="px-3 py-1.5 rounded text-xs bg-[var(--av-bg-raised)] hover:bg-[var(--av-bg-hover)] text-[var(--av-text-muted)] border border-[var(--av-border)]"
            >
              Reset
            </button>
          )}
        </div>

        {uploading && <p className="text-xs text-[var(--av-accent-cyan)]">Uploading…</p>}
        {uploadErr && <p className="text-xs text-[var(--av-accent-red)]">{uploadErr}</p>}

        {firmwareInfo && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-[var(--av-text-subtle)] mb-0.5">File</div>
              <div className="font-mono text-[var(--av-accent-cyan)] break-all">{firmwareInfo.name}</div>
            </div>
            <div>
              <div className="text-[var(--av-text-subtle)] mb-0.5">Size</div>
              <div className="font-mono text-[var(--av-text-muted)]">{formatBytes(firmwareInfo.size)}</div>
            </div>
            <div>
              <div className="text-[var(--av-text-subtle)] mb-0.5">Total Blocks</div>
              <div className="font-mono text-[var(--av-text-muted)]">{firmwareInfo.totalBlocks.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[var(--av-text-subtle)] mb-0.5">Init Payload (Port 22)</div>
              <div className="font-mono text-[var(--av-text-muted)] break-all">0x{firmwareInfo.initPayloadHex}</div>
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section C — Send Configuration                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[var(--av-border)] bg-[var(--av-bg-surface)] p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[var(--av-text-primary)]">Send Configuration</h2>

        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--av-text-muted)] whitespace-nowrap">Block interval (ms)</label>
            <input
              type="number"
              min={minIntervalMs}
              max={maxIntervalMs}
              step={500}
              value={blockIntervalMs}
              onChange={e => setBlockIntervalMs(Math.min(maxIntervalMs, Math.max(minIntervalMs, parseInt(e.target.value) || minIntervalMs)))}
              className="w-24 px-2 py-1 rounded border border-[var(--av-border)] bg-[var(--av-bg-raised)] text-xs text-[var(--av-text-primary)] font-mono focus:outline-none focus:border-[var(--av-accent-cyan)]"
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <label className="text-xs text-[var(--av-text-muted)] whitespace-nowrap">ISM Band</label>
            <select
              value={selectedIsmBand}
              onChange={e => setSelectedIsmBand(e.target.value)}
              className="flex-1 min-w-0 px-2 py-1 rounded border border-[var(--av-border)] bg-[var(--av-bg-raised)] text-xs text-[var(--av-text-primary)] focus:outline-none focus:border-[var(--av-accent-cyan)]"
            >
              <option value="">Select band…</option>
              {ISM_BAND_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {firmwareInfo && (
            <div className="text-xs text-[var(--av-text-muted)]">
              ETA: <span className="text-[var(--av-accent-cyan)] font-mono">{formatEta(firmwareInfo.totalBlocks, blockIntervalMs)}</span>
              {' '}for <span className="text-[var(--av-text-muted)]">{firmwareInfo.totalBlocks.toLocaleString()} blocks</span>
            </div>
          )}
        </div>

        <p className="text-xs text-[var(--av-text-subtle)]">
          Allowed range for selected band: {(minIntervalMs / 1000).toFixed(0)} – {(maxIntervalMs / 1000).toFixed(0)} s
        </p>
        {!selectedIsmBand && (
          <p className="text-xs text-[var(--av-text-subtle)]">
            Select the ISM band for devices that have not yet sent an uplink. Devices with a known band (from prior uplinks) will use their auto-detected region regardless.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section D — Target Devices                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-[var(--av-border)] bg-[var(--av-bg-surface)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--av-text-primary)]">
            Target Devices
            {selectedDevEuis.size > 0 && (
              <span className="ml-2 text-xs text-[var(--av-accent-cyan)] font-normal">
                {eligibleSelected.length} selected
              </span>
            )}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              disabled={devices.length === 0}
              className="text-xs px-2 py-1 rounded bg-[var(--av-bg-raised)] hover:bg-[var(--av-bg-hover)] text-[var(--av-text-muted)] border border-[var(--av-border)] disabled:opacity-40"
            >
              All
            </button>
            <button
              onClick={deselectAll}
              disabled={selectedDevEuis.size === 0}
              className="text-xs px-2 py-1 rounded bg-[var(--av-bg-raised)] hover:bg-[var(--av-bg-hover)] text-[var(--av-text-muted)] border border-[var(--av-border)] disabled:opacity-40"
            >
              None
            </button>
          </div>
        </div>

        {devicesLoading && <p className="text-xs text-[var(--av-text-subtle)]">Loading devices…</p>}
        {!devicesLoading && devices.length === 0 && (
          <p className="text-xs text-[var(--av-text-subtle)]">No devices found. Devices appear here once they send an uplink.</p>
        )}

        {!devicesLoading && devices.length > 0 && (
          <div className="overflow-x-auto max-h-56 overflow-y-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-[var(--av-bg-surface)]">
                <tr className="text-[var(--av-text-subtle)] border-b border-[var(--av-border)]">
                  <th className="pb-1.5 pl-2 text-left w-24 border border-[var(--av-border)]">Select</th>
                  <th className="pb-1.5 pl-2 text-left border border-[var(--av-border)]">DevEUI</th>
                  <th className="pb-1.5 pl-3 text-left border border-[var(--av-border)]">TPMfw Ver</th>
                  <th className="pb-1.5 pl-3 text-left border border-[var(--av-border)]">VSMfw Ver</th>
                  <th className="pb-1.5 pl-3 text-left border border-[var(--av-border)]">Config Updated</th>
                  <th className="pb-1.5 pr-2 text-right border border-[var(--av-border)]">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(device => {
                  const isActive = activeDevEuis.has(device.dev_eui);
                  const isSelected = selectedDevEuis.has(device.dev_eui);
                  return (
                    <tr
                      key={device.dev_eui}
                      onClick={() => toggleDevice(device.dev_eui)}
                      className={`cursor-pointer hover:bg-[var(--av-bg-hover)] ${isSelected ? 'bg-[var(--av-accent)]/5' : ''}`}
                    >
                      <td className="py-1.5 pl-2 border border-[var(--av-border)]">
                        {isActive ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--av-accent-amber)]/10 border border-[var(--av-accent-amber)]/40 text-[var(--av-accent-amber)]">
                            Updating
                          </span>
                        ) : (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleDevice(device.dev_eui)}
                            onClick={e => e.stopPropagation()}
                            className="accent-[var(--av-accent)] cursor-pointer"
                          />
                        )}
                      </td>
                      <td className="py-1.5 pl-2 font-mono text-[var(--av-accent-cyan)] border border-[var(--av-border)]">{device.dev_eui}</td>
                      <td className="py-1.5 pl-3 font-mono text-[var(--av-text-muted)] border border-[var(--av-border)]">
                        {device.metadata?.tpm_fw ?? <span className="text-[var(--av-text-subtle)]">—</span>}
                      </td>
                      <td className="py-1.5 pl-3 font-mono text-[var(--av-text-muted)] border border-[var(--av-border)]">
                        {device.metadata?.vsm_fw ?? <span className="text-[var(--av-text-subtle)]">—</span>}
                      </td>
                      <td className="py-1.5 pl-3 text-[var(--av-text-subtle)] border-r border-[var(--av-border)]">
                        {device.metadata?.config_updated_at
                          ? formatDate(device.metadata.config_updated_at)
                          : <span className="text-[var(--av-text-subtle)]">—</span>}
                      </td>
                      <td className="py-1.5 pr-2 text-[var(--av-text-subtle)] text-right border border-[var(--av-border)]">{formatDate(device.last_seen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Start button */}
        <div className="flex items-center gap-3 pt-1 flex-wrap">
          <button
            onClick={handleStart}
            disabled={!firmwareInfo || eligibleSelected.length === 0 || starting || needsBandSelection}
            className="px-4 py-2 rounded text-sm font-medium bg-[var(--av-accent-amber)] hover:opacity-90
              text-[var(--av-bg-base)] disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            {starting ? 'Starting…' : 'Start FUOTA Update'}
          </button>
          {!firmwareInfo && (
            <span className="text-xs text-[var(--av-text-subtle)]">Select firmware above first</span>
          )}
          {firmwareInfo && eligibleSelected.length === 0 && activeDevEuis.size === 0 && (
            <span className="text-xs text-[var(--av-text-subtle)]">Select target devices above</span>
          )}
          {needsBandSelection && (
            <span className="text-xs text-[var(--av-accent-amber)]">
              Select an ISM band —{' '}
              {devicesWithoutBand.length === 1
                ? '1 selected device has'
                : `${devicesWithoutBand.length} selected devices have`}{' '}
              no uplinks yet
            </span>
          )}
        </div>

        {startErr && <p className="text-xs text-[var(--av-accent-red)]">{startErr}</p>}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section E — Active Jobs + Session History                           */}
      {/* ------------------------------------------------------------------ */}
      {Object.keys(deviceProgress).length > 0 && (
        <div className="rounded-lg border border-[var(--av-border)] bg-[var(--av-bg-surface)] p-4 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--av-text-primary)]">Active Jobs</h2>
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

      {filteredHistory.length > 0 && (
        <div className="rounded-lg border border-[var(--av-border)] bg-[var(--av-bg-surface)] p-4 space-y-2">
          <button
            className="flex items-center gap-2 w-full text-left"
            onClick={() => setHistoryExpanded(v => !v)}
          >
            <span className="text-sm font-semibold text-[var(--av-text-primary)]">Session History</span>
            <span className="text-xs text-[var(--av-text-subtle)]">({filteredHistory.length})</span>
            <span className="ml-auto text-xs text-[var(--av-text-subtle)]">{historyExpanded ? '▲ collapse' : '▼ expand'}</span>
          </button>
          {historyExpanded && (
            <div className="space-y-2 mt-2">
              {filteredHistory.map(s => (
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
    startedAt, blocksSentAtStart, blocksResentSoFar, confirmedRanges, configPollAttempt,
    configCheckDone, classAOnly,
  } = progress;
  const pct = totalBlocks > 0 ? Math.min(100, Math.round((blocksSent / totalBlocks) * 100)) : 0;
  const isTerminal = isTerminalState(state);
  const isActive = !isTerminal && state !== 'idle';
  const isFailed = state === 'failed' || state === 'aborted';

  // ---- Timeline step states ----
  const classCOk = !!classCConfigured;

  // Whether each step has been completed (past)
  const configPollDone = !!configCheckDone ||
    ['waiting_ack', 'sending_blocks', 'resending', 'verifying', 'flashing', 'complete', 'failed', 'aborted'].includes(state);
  const initDone   = ['sending_blocks', 'resending', 'verifying', 'flashing', 'complete', 'failed', 'aborted'].includes(state);
  const blocksDone = ['verifying', 'flashing', 'complete'].includes(state) ||
                     (isFailed && blocksSent > 0 && blocksSent === totalBlocks);
  const resendDone = verifyAttempts > 1 && (state === 'verifying' || state === 'flashing' || state === 'complete');
  const verifyDone = state === 'flashing' || state === 'complete';
  const flashDone  = state === 'complete';

  // Whether each step is currently active
  const configPollActive = state === 'config_poll';
  const initActive   = state === 'waiting_ack' || state === 'initializing';
  const blocksActive = state === 'sending_blocks';
  const resendActive = state === 'resending';
  const verifyActive = state === 'verifying';
  const flashActive  = state === 'flashing';

  // Show resend node only when it has been (or is being) done
  const showResend = resendActive || resendDone || lastMissedCount > 0;

  // Connector color helper
  function connCls(lit: boolean) {
    return `h-px flex-1 min-w-[6px] ${lit ? 'bg-[var(--av-bg-raised)]' : 'bg-[var(--av-border-muted)]'}`;
  }

  // Badge class helper
  function badgeCls(done: boolean, active: boolean, failed?: boolean, warn?: boolean) {
    if (done && !isFailed) return 'text-[var(--av-text-subtle)] border-[var(--av-border-muted)]';
    if (active) return 'bg-[var(--av-accent-cyan)]/10 border-[var(--av-accent-cyan)]/40 text-[var(--av-accent-cyan)]';
    if (failed) return 'bg-[var(--av-accent-red)]/10 border-[var(--av-accent-red)]/40 text-[var(--av-accent-red)]';
    if (warn)   return 'bg-[var(--av-accent-amber)]/10 border-[var(--av-accent-amber)]/40 text-[var(--av-accent-amber)]';
    return 'border-[var(--av-border-muted)] text-[var(--av-text-subtle)]';
  }

  function initBadgeCls(done: boolean, active: boolean, failed?: boolean) {
    if (done && !failed) return 'bg-[var(--av-accent)]/10 border-[var(--av-accent)]/40 text-[var(--av-accent)]';
    if (active)          return 'bg-[var(--av-accent-amber)]/10 border-[var(--av-accent-amber)]/40 text-[var(--av-accent-amber)]';
    if (failed)          return 'bg-[var(--av-accent-red)]/10 border-[var(--av-accent-red)]/40 text-[var(--av-accent-red)]';
    return 'border-[var(--av-border-muted)] text-[var(--av-text-subtle)]';
  }

  return (
    <div className="rounded border border-[var(--av-border)] bg-[var(--av-bg-base)] p-3 space-y-3">

      {/* Header: DevEUI + firmware name */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-[var(--av-accent-cyan)]">{devEui}</span>
        {firmwareName && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--av-bg-surface)] border border-[var(--av-border)] text-[var(--av-text-subtle)]">
            {firmwareName}
          </span>
        )}
      </div>

      {/* Timeline */}
      {(isActive || isTerminal) && (
        <div className="flex items-center gap-0.5 text-[11px] overflow-x-auto">
          {/* Config poll */}
          <span className={`px-2 py-0.5 rounded border shrink-0 ${
            configPollActive
              ? 'bg-[var(--av-accent-purple)]/10 border-[var(--av-accent-purple)]/40 text-[var(--av-accent-purple)]'
              : configPollDone
              ? 'bg-[var(--av-accent)]/10 border-[var(--av-accent)]/40 text-[var(--av-accent)]'
              : 'border-[var(--av-border-muted)] text-[var(--av-text-subtle)]'
          }`}>
            {configPollDone ? 'Config ✓' : configPollActive ? `Config ${configPollAttempt ?? 0}/3` : 'Config'}
          </span>

          <div className={connCls(configPollDone || configPollActive)} />

          {/* Class C */}
          <span className={`px-2 py-0.5 rounded border shrink-0 ${
            classCOk
              ? 'bg-[var(--av-accent)]/10 border-[var(--av-accent)]/40 text-[var(--av-accent)]'
              : classAOnly
              ? 'bg-[var(--av-accent-cyan)]/10 border-[var(--av-accent-cyan)]/40 text-[var(--av-accent-cyan)]'
              : 'bg-[var(--av-accent-amber)]/10 border-[var(--av-accent-amber)]/40 text-[var(--av-accent-amber)]'
          }`}>
            {classCOk ? 'Class C ✓' : classAOnly ? 'Class A ✓' : 'Class A'}
          </span>

          <div className={connCls(initDone || initActive)} />

          {/* Init */}
          <span className={`px-2 py-0.5 rounded border shrink-0 ${initBadgeCls(initDone, initActive)}`}>
            {initDone ? 'Init ✓' : 'Init'}
          </span>

          <div className={connCls(blocksDone || blocksActive)} />

          {/* Blocks */}
          <span className={`px-2 py-0.5 rounded border shrink-0 ${badgeCls(blocksDone, blocksActive)}`}>
            {blocksActive ? `Blocks ${pct}%` : 'Blocks'}
          </span>

          {/* Resend (conditional) */}
          {showResend && (
            <>
              <div className={connCls(resendDone || resendActive)} />
              <span className={`px-2 py-0.5 rounded border shrink-0 ${badgeCls(resendDone, resendActive)}`}>
                {resendActive && lastMissedCount > 0 ? `Re-send ${lastMissedCount}` : 'Re-send'}
              </span>
            </>
          )}

          <div className={connCls(verifyDone || verifyActive || resendActive)} />

          {/* Verify */}
          <span className={`px-2 py-0.5 rounded border shrink-0 ${
            verifyActive || resendActive
              ? 'bg-[var(--av-accent-amber)]/10 border-[var(--av-accent-amber)]/40 text-[var(--av-accent-amber)]'
              : badgeCls(verifyDone, false, isFailed && verifyAttempts > 0)
          }`}>
            Verify{verifyAttempts > 1 ? ` ×${verifyAttempts}` : ''}
          </span>

          <div className={connCls(verifyDone || verifyActive)} />

          {/* Flash */}
          <span className={`px-2 py-0.5 rounded border shrink-0 ${
            flashActive
              ? 'bg-[var(--av-accent-amber)]/20 border-[var(--av-accent-amber)]/60 text-[var(--av-accent-amber)]'
              : badgeCls(flashDone, false, isFailed && verifyDone)
          }`}>
            Flash
          </span>

          <div className={connCls(flashDone || isFailed)} />

          {/* Done */}
          <span className={`px-2 py-0.5 rounded border shrink-0 ${
            flashDone
              ? 'bg-[var(--av-accent)]/10 border-[var(--av-accent)]/40 text-[var(--av-accent)]'
              : isFailed
              ? 'bg-[var(--av-accent-red)]/10 border-[var(--av-accent-red)]/40 text-[var(--av-accent-red)]'
              : 'border-[var(--av-border-muted)] text-[var(--av-text-subtle)]'
          }`}>
            {isFailed ? (state === 'aborted' ? 'Aborted' : 'Failed') : 'Done'}
          </span>
        </div>
      )}

      {/* Block status map — visible once blocks are being sent */}
      {totalBlocks > 0 && (blocksSent > 0 || isTerminal) && (
        <BlockStatusMap
          totalBlocks={totalBlocks}
          blocksSent={blocksSent}
          confirmedRanges={confirmedRanges ?? []}
          lastMissedBlocks={lastMissedBlocks ?? []}
          blocksResentSoFar={blocksResentSoFar ?? 0}
          blockIntervalMs={blockIntervalMs}
          startedAt={startedAt}
          blocksSentAtStart={blocksSentAtStart}
          state={state}
        />
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-[var(--av-accent-red)] font-mono break-all">{error}</p>
      )}

      {/* Bottom row: status text + ETA left, Abort right */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--av-text-subtle)]">
          {state === 'config_poll' && (
            <span className="text-[var(--av-accent-purple)]">
              Requesting device configuration{configPollAttempt ? ` (attempt ${configPollAttempt}/3)` : ''}…
            </span>
          )}
          {state === 'waiting_ack' && (
            <span className="text-[var(--av-accent-cyan)]">Waiting for 0x10 ACK…</span>
          )}
          {state === 'verifying' && (
            <span className="text-[var(--av-accent-amber)]">
              Waiting for 0x11 verify uplink{verifyAttempts > 0 ? ` (attempt ${verifyAttempts})` : ''}…
            </span>
          )}
          {state === 'resending' && lastMissedCount > 0 && (() => {
            const sent = blocksResentSoFar ?? 0;
            if (sent >= lastMissedCount) {
              return <span className="text-[var(--av-accent-amber)]">All {lastMissedCount} block{lastMissedCount !== 1 ? 's' : ''} resent — waiting before next verify…</span>;
            }
            return (
              <span className="text-[var(--av-accent-amber)]">
                Re-sending {sent + 1} of {lastMissedCount} missed blocks…
              </span>
            );
          })()}
          {state === 'flashing' && (
            <span className="text-[var(--av-accent-amber)]">All blocks confirmed — writing firmware to flash…</span>
          )}
          {state === 'complete' && (
            <span className="text-[var(--av-accent)]">Flash write confirmed — firmware update applied</span>
          )}
        </div>

        {isActive && (
          <button
            onClick={onAbort}
            className="text-xs px-2.5 py-1 rounded border border-red-700 text-red-400 hover:bg-red-900/30 shrink-0"
          >
            Abort
          </button>
        )}
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// BlockStatusMap — full block-range visualization, SegmentMap pattern
// ---------------------------------------------------------------------------

const BLOCK_COLORS = {
  unsent:    { bg: 'transparent',  border: '#334155', label: 'Unsent' },
  sent:      { bg: '#eab308',      border: '#ca8a04', label: 'Sent (unconfirmed)' },
  missing:   { bg: '#ef4444',      border: '#dc2626', label: 'Missing' },
  confirmed: { bg: '#22c55e',      border: '#16a34a', label: 'Confirmed' },
} as const;

type BlockState = keyof typeof BLOCK_COLORS;

// Number of buckets used only for the CSS gradient bar (3877 stops would be huge)
const GRADIENT_BUCKETS = 200;

/** Binary-search range membership — confirmedRanges must be sorted. */
function inAnyRange(b: number, ranges: [number, number][]): boolean {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [rlo, rhi] = ranges[mid];
    if (b >= rlo && b <= rhi) return true;
    if (b < rlo) hi = mid - 1; else lo = mid + 1;
  }
  return false;
}

function BlockStatusMap({
  totalBlocks,
  blocksSent,
  confirmedRanges,
  lastMissedBlocks,
  blocksResentSoFar,
  blockIntervalMs,
  startedAt,
  blocksSentAtStart,
  state,
}: {
  totalBlocks: number;
  blocksSent: number;
  confirmedRanges: [number, number][];
  lastMissedBlocks: number[];
  blocksResentSoFar: number;
  blockIntervalMs?: number;
  startedAt?: number;
  blocksSentAtStart?: number;
  state: FuotaState;
}) {
  const [expanded, setExpanded] = useState(false);

  // During resending: blocks not yet resent in this cycle are "missing" (red)
  // During verifying and other states: no blocks are currently red — they were
  // all resent before the verify command was sent
  const pendingMissedSet = new Set<number>(
    state === 'resending' ? lastMissedBlocks.slice(blocksResentSoFar) : []
  );

  // Gradient bar: bucketed to GRADIENT_BUCKETS stops for CSS performance
  const gradientBucketCount = Math.min(totalBlocks, GRADIENT_BUCKETS);
  const gradientCells: BlockState[] = Array.from({ length: gradientBucketCount }, (_, i) => {
    const lo = Math.floor(i * totalBlocks / gradientBucketCount);
    const hi = Math.floor((i + 1) * totalBlocks / gradientBucketCount);
    let hasMissing = false, hasSent = false, hasConfirmed = false;
    for (let b = lo; b < hi; b++) {
      if (pendingMissedSet.has(b)) { hasMissing = true; break; }
      if (inAnyRange(b, confirmedRanges)) { hasConfirmed = true; }
      else if (b < blocksSent) { hasSent = true; }
    }
    if (hasMissing) return 'missing';
    if (hasSent)    return 'sent';
    if (hasConfirmed) return 'confirmed';
    return 'unsent';
  });

  // Expanded grid: one circle per block (1:1)
  const gridCells: BlockState[] = Array.from({ length: totalBlocks }, (_, i) => {
    if (pendingMissedSet.has(i)) return 'missing';
    if (inAnyRange(i, confirmedRanges)) return 'confirmed';
    if (i < blocksSent) return 'sent';
    return 'unsent';
  });

  // Counts for summary line
  const confirmedCount = confirmedRanges.reduce((acc, [lo, hi]) => acc + hi - lo + 1, 0);
  const pendingCount = pendingMissedSet.size;
  const pct = totalBlocks > 0 ? Math.min(100, Math.round(blocksSent / totalBlocks * 100)) : 0;
  const isFailed = state === 'failed' || state === 'aborted';

  const eta = state === 'sending_blocks'
    ? formatObservedEta(totalBlocks - blocksSent, blocksSent, startedAt, blockIntervalMs, blocksSentAtStart)
    : null;

  return (
    <div className="space-y-1.5">
      {/* Summary bar — always visible, click to expand circle grid */}
      <div
        className="flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex-1 min-w-0 space-y-1">
          {/* Counts row */}
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--av-text-muted)]">
            <span className={`font-bold ${state === 'complete' ? 'text-[var(--av-accent)]' : isFailed ? 'text-[var(--av-accent-red)]' : 'text-[var(--av-text-primary)]'}`}>
              {pct}%
            </span>
            <span className="text-[var(--av-text-subtle)]">·</span>
            <span>
              <span className="font-mono">{blocksSent.toLocaleString()}</span>
              <span className="text-[var(--av-text-subtle)]">/{totalBlocks.toLocaleString()} sent</span>
            </span>
            {confirmedCount > 0 && (
              <>
                <span className="text-[var(--av-text-subtle)]">·</span>
                <span className="text-[var(--av-accent)] font-mono">{confirmedCount.toLocaleString()}</span>
                <span className="text-[var(--av-text-subtle)]"> confirmed</span>
              </>
            )}
            {pendingCount > 0 && (
              <>
                <span className="text-[var(--av-text-subtle)]">·</span>
                <span className="text-[var(--av-accent-red)] font-mono">{pendingCount}</span>
                <span className="text-[var(--av-text-subtle)]"> missing</span>
              </>
            )}
            {eta && (
              <>
                <span className="text-[var(--av-text-subtle)]">·</span>
                <span className="text-[var(--av-accent-cyan)] font-mono">{eta}</span>
                <span className="text-[var(--av-text-subtle)]"> remaining</span>
              </>
            )}
          </div>
          {/* CSS gradient bar */}
          <div
            className="w-full h-1.5 rounded-full"
            style={{
              background: gradientCells.length > 0
                ? `linear-gradient(to right, ${gradientCells.map((s, i) => {
                    const n = gradientCells.length;
                    const start = (i / n * 100).toFixed(2);
                    const end = ((i + 1) / n * 100).toFixed(2);
                    const bg = BLOCK_COLORS[s].bg === 'transparent' ? '#1e293b' : BLOCK_COLORS[s].bg;
                    return `${bg} ${start}% ${end}%`;
                  }).join(', ')})`
                : '#1e293b',
            }}
          />
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`h-4 w-4 text-[var(--av-text-subtle)] shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20" fill="currentColor"
        >
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </div>

      {/* Expanded circle grid — one circle per block (1:1) */}
      {expanded && (
        <div className="mt-1">
          <div className="max-h-72 overflow-y-auto flex flex-wrap gap-0.5 p-3 bg-[var(--av-bg-base)] rounded-lg border border-[var(--av-border)]">
            {gridCells.map((s, i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  background: BLOCK_COLORS[s].bg === 'transparent' ? 'transparent' : BLOCK_COLORS[s].bg,
                  border: `1px solid ${BLOCK_COLORS[s].border}`,
                }}
                title={`Block ${i}: ${BLOCK_COLORS[s].label}`}
              />
            ))}
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-3 mt-2">
            {(Object.entries(BLOCK_COLORS) as [BlockState, typeof BLOCK_COLORS[BlockState]][]).map(([key, { bg, border, label }]) => (
              <div key={key} className="flex items-center gap-1 text-[10px] text-[var(--av-text-subtle)]">
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                  style={{
                    background: bg === 'transparent' ? 'transparent' : bg,
                    border: `1.5px solid ${border}`,
                  }}
                />
                {label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Missed block chips — only shown during active resend cycle */}
      {state === 'resending' && lastMissedBlocks.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-[var(--av-text-subtle)]">
            Last 0x11 reported {lastMissedBlocks.length} missing block{lastMissedBlocks.length !== 1 ? 's' : ''}
            {blocksResentSoFar > 0 && (
              <span> · <span className="text-[var(--av-accent-amber)]">{Math.min(blocksResentSoFar, lastMissedBlocks.length)} resent</span></span>
            )}
            {pendingCount > 0 && (
              <span> · <span className="text-[var(--av-accent-red)]">{pendingCount} pending</span></span>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {lastMissedBlocks.map((b, idx) => (
              <span
                key={b}
                className={`font-mono text-[10px] px-1 py-0.5 rounded border ${
                  idx < blocksResentSoFar
                    ? 'bg-[var(--av-accent-amber)]/10 border-[var(--av-accent-amber)]/40 text-[var(--av-accent-amber)]'
                    : 'bg-[var(--av-accent-red)]/10 border-[var(--av-accent-red)]/40 text-[var(--av-accent-red)]'
                }`}
              >
                {b}
              </span>
            ))}
          </div>
        </div>
      )}
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
    <div className="rounded border border-[var(--av-border)] bg-[var(--av-bg-base)] p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-[var(--av-accent-cyan)]">{session.device_eui}</span>
          <span className="text-xs text-[var(--av-text-subtle)]">{session.firmware_name}</span>
        </div>
        <span className={`text-xs border rounded px-2 py-0.5 ${stateBadgeClass(session.status as FuotaState)}`}>
          {session.status}
        </span>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-[var(--av-text-subtle)]">
        <span>Blocks: <span className="text-[var(--av-text-muted)]">{session.blocks_sent}/{session.total_blocks}</span> ({pct}%)</span>
        {session.verify_attempts > 0 && (
          <span>Verify: <span className="text-[var(--av-text-muted)]">{session.verify_attempts}</span></span>
        )}
        <span>Started: <span className="text-[var(--av-text-muted)]">{formatDate(session.started_at)}</span></span>
        {session.completed_at && (
          <span>Ended: <span className="text-[var(--av-text-muted)]">{formatDate(session.completed_at)}</span></span>
        )}
      </div>
      {session.error && (
        <p className="text-xs text-[var(--av-accent-red)] font-mono break-all">{session.error}</p>
      )}
    </div>
  );
}
