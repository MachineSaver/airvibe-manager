"use client";

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { COMMAND_PRESETS } from '@/lib/commandPresets';
import { encodeDownlink, bytesToHex } from '@/lib/codec';

const CopyIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

interface DownlinkBuilderProps {
  socket: Socket | null;
  messages: { topic: string; payload: string; timestamp: string }[];
}

export default function DownlinkBuilder({ socket, messages }: DownlinkBuilderProps) {
  const [topic, setTopic] = useState('mqtt/things/[DevEUI]/downlink');
  const [devEui, setDevEui] = useState('');
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [host] = useState(() =>
    typeof window !== 'undefined' ? window.location.hostname : ''
  );

  const [selectedPresetName, setSelectedPresetName] = useState<string>('');
  const [customFPort, setCustomFPort] = useState('22');
  const [customPayload, setCustomPayload] = useState('');

  const [waveformTxId, setWaveformTxId] = useState('');
  const [missedSegSize, setMissedSegSize] = useState<'00' | '01'>('00');
  const [missedSegIndices, setMissedSegIndices] = useState<string>('');
  const [inputFormat, setInputFormat] = useState<'hex' | 'decimal'>('hex');
  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Codec JSON editor state — tracks which preset last initialized the text
  const [codecJsonText, setCodecJsonText] = useState('');
  const [lastCodecPreset, setLastCodecPreset] = useState<string>('');

  // DevEUI Discovery — API-based with message fallback
  const [apiDevEuis, setApiDevEuis] = useState<string[]>([]);

  const fetchDevices = useCallback(async () => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
      const res = await fetch(`${apiUrl}/api/devices`);
      const data = await res.json();
      setApiDevEuis(data.map((d: { dev_eui: string }) => d.dev_eui));
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(fetchDevices, 0);
    const interval = setInterval(fetchDevices, 10000);
    return () => { clearTimeout(timeout); clearInterval(interval); };
  }, [fetchDevices]);

  // Merge API devices with message-derived EUIs for immediate discovery
  const knownDevEuis = useMemo(() => {
    const euis = new Set<string>(apiDevEuis);
    for (const msg of messages) {
      try {
        let payload: unknown = msg.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            continue;
          }
        }
        if (typeof payload === 'object' && payload !== null) {
          const uplinkData = (payload as Record<string, unknown>).DevEUI_uplink as Record<string, unknown> | undefined;
          if (uplinkData && typeof uplinkData.DevEUI === 'string') {
            euis.add(uplinkData.DevEUI);
          }
        }
      } catch {
        // Ignore parsing errors
      }
    }
    return euis;
  }, [apiDevEuis, messages]);

  const selectedPreset = useMemo(() =>
    COMMAND_PRESETS.find(p => p.name === selectedPresetName),
    [selectedPresetName]);

  // Initialize codec JSON text when a new codec preset is selected
  if (selectedPreset?.type === 'codec' && selectedPreset.codecInput && selectedPresetName !== lastCodecPreset) {
    setCodecJsonText(JSON.stringify(selectedPreset.codecInput, null, 2));
    setLastCodecPreset(selectedPresetName);
  } else if (selectedPresetName !== lastCodecPreset) {
    setLastCodecPreset(selectedPresetName);
  }

  // Codec encoding result (derived from codecJsonText)
  const codecResult = useMemo(() => {
    if (!selectedPreset || selectedPreset.type !== 'codec') return null;

    try {
      const parsed = JSON.parse(codecJsonText);
      const result = encodeDownlink({ fPort: selectedPreset.fPort, data: parsed });
      return result;
    } catch (e) {
      return {
        fPort: selectedPreset.fPort,
        bytes: [] as number[],
        errors: [(e as Error).message],
        warnings: [] as string[]
      };
    }
  }, [selectedPreset, codecJsonText]);

  // Missed segments validation (derived state, not an effect)
  const missedSegError = useMemo(() => {
    if (!missedSegIndices) return null;

    const parts = missedSegIndices.split(',').map(s => s.trim()).filter(s => s !== '');
    let hasSmall = false;
    let hasLarge = false;

    for (const part of parts) {
      let num = 0;
      if (inputFormat === 'hex') {
        if (!/^[0-9A-Fa-f]+$/.test(part)) continue;
        num = parseInt(part, 16);
      } else {
        if (!/^\d+$/.test(part)) continue;
        num = parseInt(part, 10);
      }

      if (isNaN(num)) continue;

      if (num > 65535) {
        return `Value ${part} exceeds 2 bytes (65535)`;
      }

      if (num > 255) hasLarge = true;
      else hasSmall = true;
    }

    if (hasSmall && hasLarge) {
      return "Cannot mix 1-byte (<=255) and 2-byte (>255) indices.";
    }
    if (missedSegSize === '00' && hasLarge) {
      return "Value > 255 requires 2-byte mode.";
    }
    if (missedSegSize === '01' && hasSmall) {
      return "Value <= 255 should use 1-byte mode.";
    }

    return null;
  }, [missedSegIndices, missedSegSize, inputFormat]);

  const currentPayloadHex = useMemo(() => {
    if (!selectedPreset) return customPayload;

    if (selectedPreset.type === 'codec') {
      if (codecResult && codecResult.errors.length === 0 && codecResult.bytes.length > 0) {
        return bytesToHex(codecResult.bytes);
      }
      return '';
    }

    if (selectedPreset.type === 'simple') {
      return selectedPreset.staticPayload || '';
    }

    if (selectedPreset.type === 'waveform_ack') {
      const cmdByte = selectedPreset.name.includes('TWI') ? '03' : '01';
      return `${cmdByte}${waveformTxId || '00'}`;
    }

    if (selectedPreset.type === 'missed_segments') {
      const parts = missedSegIndices.split(',')
        .map(s => s.trim())
        .filter(s => s !== '');

      const count = parts.length;
      const countHex = count.toString(16).padStart(2, '0').toUpperCase();

      const paddedIndices = parts.map(part => {
        let val = 0;
        if (inputFormat === 'hex') {
          val = parseInt(part, 16);
        } else {
          val = parseInt(part, 10);
        }
        if (isNaN(val)) return '';
        const hexVal = val.toString(16).toUpperCase();
        const targetLen = missedSegSize === '00' ? 2 : 4;
        return hexVal.padStart(targetLen, '0');
      }).join('');

      return `${missedSegSize}${countHex}${paddedIndices}`.toUpperCase();
    }

    return '';
  }, [selectedPreset, customPayload, waveformTxId, missedSegSize, missedSegIndices, inputFormat, codecResult]);

  const currentFPort = useMemo(() => {
    return selectedPreset ? selectedPreset.fPort.toString() : customFPort;
  }, [selectedPreset, customFPort]);

  const getJsonPayload = () => {
    return JSON.stringify({
      DevEUI_downlink: {
        DevEUI: devEui || "8C1F64...",
        FPort: parseInt(currentFPort) || 22,
        payload_hex: currentPayloadHex || "0000"
      }
    }, null, 2);
  };

  const publishMessage = () => {
    if (!socket) return;
    const finalTopic = topic.replace('[DevEUI]', devEui || '8C1F642113000533');
    socket.emit('publish', {
      topic: finalTopic,
      payload: getJsonPayload()
    });
  };

  const copyToClipboard = (text: string, type: 'json' | 'cmd') => {
    navigator.clipboard.writeText(text);
    if (type === 'json') {
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } else {
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2000);
    }
  };

  return (
    <div className="overflow-auto p-6 bg-[#1e1e1e]">
      <div className="space-y-6 max-w-xl">

        {/* Broker Connection (Read Only) */}
        <div className="bg-[#252526] p-4 rounded border border-[#333]">
          <h3 className="text-xs font-semibold text-green-500 uppercase mb-3">Broker Connection</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-[10px] text-gray-500 mb-1">HOST</label>
              <input type="text" readOnly value={host} className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300" suppressHydrationWarning />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">PORT</label>
              <input type="text" readOnly value="8883" className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300" />
            </div>
          </div>
        </div>

        {/* MQTT Message Config */}
        <div className="bg-[#252526] p-4 rounded border border-[#333]">
          <h3 className="text-xs font-semibold text-green-500 uppercase mb-3">MQTT Message</h3>

          <div className="mb-4">
            <label className="block text-[10px] text-gray-500 mb-1">TOPIC</label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
            />
          </div>

          <div className="mb-4">
            <label className="block text-[10px] text-gray-500 mb-1">DevEUI</label>
            {knownDevEuis.size > 0 && !isCustomMode ? (
              <select
                value={devEui}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__custom__') {
                    setIsCustomMode(true);
                    setDevEui('');
                  } else {
                    setDevEui(val);
                  }
                }}
                className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
              >
                <option value="">-- Select DevEUI --</option>
                {Array.from(knownDevEuis).map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
                <option value="__custom__">-- Enter Custom DevEUI --</option>
              </select>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={devEui}
                  onChange={(e) => setDevEui(e.target.value)}
                  placeholder="Enter DevEUI..."
                  className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
                  autoFocus={isCustomMode}
                />
                {knownDevEuis.size > 0 && (
                  <button
                    onClick={() => setIsCustomMode(false)}
                    className="absolute right-2 top-1/2 transform -translate-y-1/2 text-[10px] text-blue-400 hover:text-blue-300"
                  >
                    List
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="mb-4">
            <label className="block text-[10px] text-gray-500 mb-1">COMMAND PRESET</label>
            <select
              value={selectedPresetName}
              onChange={(e) => setSelectedPresetName(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
            >
              <option value="">-- Custom Command --</option>
              {COMMAND_PRESETS.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            {selectedPreset?.notes && (
              <p className="text-[10px] text-gray-400 mt-1 italic">{selectedPreset.notes}</p>
            )}
          </div>

          {/* Codec JSON Editor */}
          {selectedPreset?.type === 'codec' && (
            <div className="mb-4 p-3 bg-[#1e1e1e] rounded border border-[#3e3e42]">
              <label className="block text-[10px] text-blue-400 mb-1 uppercase">Codec Input (JSON)</label>
              <textarea
                value={codecJsonText}
                onChange={(e) => setCodecJsonText(e.target.value)}
                spellCheck={false}
                rows={Math.min(20, Math.max(4, codecJsonText.split('\n').length + 1))}
                className="w-full bg-[#252526] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none font-mono resize-y"
              />
              {codecResult && codecResult.errors.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {codecResult.errors.map((err, i) => (
                    <p key={i} className="text-[9px] text-red-500">{err}</p>
                  ))}
                </div>
              )}
              {codecResult && codecResult.warnings.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {codecResult.warnings.map((warn, i) => (
                    <p key={i} className="text-[9px] text-yellow-500">{warn}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Dynamic Inputs based on Preset Type */}
          {selectedPreset?.type === 'waveform_ack' && (
            <div className="mb-4 p-3 bg-[#1e1e1e] rounded border border-[#3e3e42]">
              <label className="block text-[10px] text-blue-400 mb-1">Waveform TXID (Hex)</label>
              <input
                type="text"
                value={waveformTxId}
                onChange={(e) => setWaveformTxId(e.target.value)}
                placeholder="FF"
                maxLength={2}
                className="w-20 bg-[#252526] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none font-mono"
              />
            </div>
          )}

          {selectedPreset?.type === 'missed_segments' && (
            <div className="mb-4 p-3 bg-[#1e1e1e] rounded border border-[#3e3e42] space-y-3">
              <div className="flex justify-end">
                <div className="bg-[#252526] p-1 rounded border border-[#3e3e42] flex text-[10px]">
                  <button
                    onClick={() => setInputFormat('hex')}
                    className={`px-3 py-1 rounded transition-colors ${inputFormat === 'hex' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
                  >
                    Hex
                  </button>
                  <button
                    onClick={() => setInputFormat('decimal')}
                    className={`px-3 py-1 rounded transition-colors ${inputFormat === 'decimal' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
                  >
                    Decimal
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-blue-400 mb-1">Size of Values</label>
                <select
                  value={missedSegSize}
                  onChange={(e) => setMissedSegSize(e.target.value as '00' | '01')}
                  className="w-full bg-[#252526] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
                >
                  <option value="00">1 Byte per Value (Indices &lt; 256)</option>
                  <option value="01">2 Bytes per Value (Indices &gt; 255)</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] text-blue-400 mb-1">
                  Missed Segment Indices ({inputFormat === 'hex' ? 'Hex' : 'Decimal'}, comma separated)
                </label>
                <input
                  type="text"
                  value={missedSegIndices}
                  onChange={(e) => setMissedSegIndices(e.target.value)}
                  placeholder={inputFormat === 'hex' ? (missedSegSize === '00' ? "01, 4C, FF" : "0105, 0A01") : "1, 76, 255"}
                  className={`w-full bg-[#252526] border rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none font-mono ${missedSegError ? 'border-red-500' : 'border-[#3e3e42]'}`}
                />
                {missedSegError && <p className="text-[9px] text-red-500 mt-1">{missedSegError}</p>}
                <p className="text-[9px] text-gray-500 mt-1">
                  Number of values will be calculated automatically.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="col-span-2">
              <label className="block text-[10px] text-gray-500 mb-1">PAYLOAD (HEX)</label>
              <input
                type="text"
                value={currentPayloadHex}
                onChange={(e) => !selectedPreset && setCustomPayload(e.target.value)}
                readOnly={!!selectedPreset}
                placeholder="0002"
                className={`w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none font-mono ${selectedPreset ? 'opacity-75 cursor-not-allowed' : ''}`}
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 mb-1">FPort</label>
              <input
                type="text"
                value={currentFPort}
                onChange={(e) => !selectedPreset && setCustomFPort(e.target.value)}
                readOnly={!!selectedPreset}
                className={`w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none ${selectedPreset ? 'opacity-75 cursor-not-allowed' : ''}`}
              />
            </div>
          </div>
        </div>

        {/* JSON Preview */}
        <div className="bg-[#252526] p-4 rounded border border-[#333]">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-xs font-semibold text-blue-400 uppercase">MQTT Payload Preview</h3>
            <button
              onClick={() => copyToClipboard(getJsonPayload(), 'json')}
              className="flex items-center space-x-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              <span>{copiedJson ? 'Copied!' : 'Copy JSON'}</span>
              {copiedJson ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>
          <pre className="bg-[#1e1e1e] p-2 rounded border border-[#3e3e42] text-[10px] text-green-400 font-mono overflow-x-auto">
            {getJsonPayload()}
          </pre>
        </div>

        {/* Command Preview */}
        <div className="bg-[#252526] p-4 rounded border border-[#333]">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-xs font-semibold text-blue-400 uppercase">Mosquitto Pub Command</h3>
            <button
              onClick={() => {
                const cmd = `mosquitto_pub -h ${host} -p 8883 -t "${topic.replace('[DevEUI]', devEui || '8C1F64...')}" -m '${getJsonPayload()}'`;
                copyToClipboard(cmd, 'cmd');
              }}
              className="flex items-center space-x-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              <span>{copiedCmd ? 'Copied!' : 'Copy Command'}</span>
              {copiedCmd ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>
          <div className="bg-[#1e1e1e] p-2 rounded border border-[#3e3e42] text-[10px] text-gray-400 font-mono break-all">
            mosquitto_pub -h {host} -p 8883 -t &quot;{topic.replace('[DevEUI]', devEui || '8C1F64...')}&quot; -m &apos;{getJsonPayload()}&apos;
          </div>
        </div>

        {/* Publish Button */}
        <button
          onClick={publishMessage}
          className="w-full bg-green-600 hover:bg-green-700 text-white py-2 rounded transition-colors font-medium text-sm"
        >
          Publish Downlink
        </button>

      </div>
    </div>
  );
}
