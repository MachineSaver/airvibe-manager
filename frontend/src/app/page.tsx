"use client";

import { useState, useEffect, useMemo } from 'react';
import { SocketProvider, useSocket } from './SocketContext';
import MQTTMessageCard from '../components/MQTTMessageCard';

// --- Types & Constants ---

type CommandPresetType = 'simple' | 'waveform_ack' | 'missed_segments';

interface CommandPreset {
  name: string;
  fPort: number;
  type: CommandPresetType;
  staticPayload?: string;
  notes?: string;
  params?: {
    label: string;
    key: string;
    type: 'text' | 'number' | 'hex';
    placeholder?: string;
    description?: string;
  }[];
}

const COMMAND_PRESETS: CommandPreset[] = [
  {
    name: "Request Current TWF Info Packet",
    fPort: 22,
    type: 'simple',
    staticPayload: "0001",
    notes: "Requests the current Time Waveform configuration."
  },
  {
    name: "Request Current Sensor Configuration Packet",
    fPort: 22,
    type: 'simple',
    staticPayload: "0002",
    notes: "Requests the current sensor configuration."
  },
  {
    name: "Trigger New TWF Collection",
    fPort: 22,
    type: 'simple',
    staticPayload: "0003",
    notes: "Triggers a new Time Waveform collection immediately."
  },
  {
    name: "Initialize AirVibe TPM/VSM Upgrade Session",
    fPort: 22,
    type: 'simple',
    staticPayload: "0005",
    notes: "Warning - this will set the AirVibe into Class C Mode which will use more battery."
  },
  {
    name: "Verify Upgrade Image Data",
    fPort: 22,
    type: 'simple',
    staticPayload: "0006",
    notes: "Verifies the uploaded firmware image."
  },
  {
    name: "Alarm - Set Off",
    fPort: 31,
    type: 'simple',
    staticPayload: "00000000000000000000000000000000",
    notes: "Disables all alarms."
  },
  {
    name: "Alarm - Set Temp 50",
    fPort: 31,
    type: 'simple',
    staticPayload: "00011388000000000000000000000000",
    notes: "Sets temperature alarm threshold to 50."
  },
  {
    name: "Alarm - Set Accel 0.5 g RMS",
    fPort: 31,
    type: 'simple',
    staticPayload: "000E000001F401F401F4000000000000",
    notes: "Sets acceleration alarm to 0.5 g RMS."
  },
  {
    name: "Alarm - Set Accel 0.1 in/sec RMS",
    fPort: 31,
    type: 'simple',
    staticPayload: "00710000000000000000006400640064",
    notes: "Sets acceleration alarm to 0.1 in/sec RMS."
  },
  {
    name: "Configuration - Overall Only Mode 1 Minute",
    fPort: 30,
    type: 'simple',
    staticPayload: "0201070881000F000100D2000213880100010019"
  },
  {
    name: "Configuration - Overall Only Mode 5 Minute",
    fPort: 30,
    type: 'simple',
    staticPayload: "0201070881000F000500D2000213880100050019"
  },
  {
    name: "Configuration - Overall Only Mode 10 Minute",
    fPort: 30,
    type: 'simple',
    staticPayload: "0201070881000F000A00D2000213880100010019",
    notes: "Includes 1 Minute Alarm Checks."
  },
  {
    name: "Configuration - TWF Only Mode (TriAxial)",
    fPort: 30,
    type: 'simple',
    staticPayload: "0202070881000f00020015000213880100020019"
  },
  {
    name: "Configuration - TWF Only Mode (Axis 1)",
    fPort: 30,
    type: 'simple',
    staticPayload: "0202010881000f0002003f000213880100020019"
  },
  {
    name: "Configuration - TWF Only Mode (Axis 2)",
    fPort: 30,
    type: 'simple',
    staticPayload: "0202020881000f0002003f000213880100020019"
  },
  {
    name: "Configuration - TWF Only Mode (Axis 3)",
    fPort: 30,
    type: 'simple',
    staticPayload: "0202040881000f0002003f000213880100020019"
  },
  {
    name: "Configuration - Dual Mode 5 Min Overall, Max Tri-Axial",
    fPort: 30,
    type: 'simple',
    staticPayload: "0203070881000F00051000000213880100050019"
  },
  {
    name: "Waveform Control - TWI Acknowledge",
    fPort: 20,
    type: 'waveform_ack',
    notes: "Signals receipt of waveform info. Command byte is 03.",
    params: [{ label: "Waveform TXID (Hex)", key: "txid", type: "hex", placeholder: "FF", description: "1 Byte Hex" }]
  },
  {
    name: "Waveform Control - TWD Acknowledge",
    fPort: 20,
    type: 'waveform_ack',
    notes: "Signals verification of no missing segments. Command byte is 01.",
    params: [{ label: "Waveform TXID (Hex)", key: "txid", type: "hex", placeholder: "FF", description: "1 Byte Hex" }]
  },
  {
    name: "Waveform Control - TWF Missing Segments",
    fPort: 21,
    type: 'missed_segments',
    notes: "Requests re-transmission of missing segments."
  }
];

// --- Icons ---

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

// --- Component ---

function AppContent() {
  const { connected, messages, socket } = useSocket();
  const [activeView, setActiveView] = useState<'mqtt' | 'certs'>('mqtt');
  const [clientId, setClientId] = useState('');
  const [certResult, setCertResult] = useState<any>(null);

  // Downlink Builder State
  const [topic, setTopic] = useState('mqtt/things/[DevEUI]/downlink');
  const [devEui, setDevEui] = useState('');
  const [knownDevEuis, setKnownDevEuis] = useState<Set<string>>(new Set());
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [host, setHost] = useState('');

  // Preset State
  const [selectedPresetName, setSelectedPresetName] = useState<string>('');
  const [customFPort, setCustomFPort] = useState('22');
  const [customPayload, setCustomPayload] = useState('');

  // Dynamic Params State
  const [waveformTxId, setWaveformTxId] = useState('');
  const [missedSegSize, setMissedSegSize] = useState<'00' | '01'>('00');
  const [missedSegIndices, setMissedSegIndices] = useState<string>(''); // Comma separated
  const [inputFormat, setInputFormat] = useState<'hex' | 'decimal'>('hex');
  const [missedSegError, setMissedSegError] = useState<string | null>(null);

  // UI Feedback
  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Initialize host
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setHost(window.location.hostname);
    }
  }, []);

  // DevEUI Discovery
  useEffect(() => {
    messages.forEach(msg => {
      try {
        let payload = msg.payload;

        // If payload is a string, try to parse it as JSON
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch (e) {
            // Not JSON, skip
            return;
          }
        }

        if (typeof payload === 'object' && payload !== null) {
          // Check for DevEUI_uplink wrapper
          const uplinkData = (payload as any).DevEUI_uplink;
          if (uplinkData && uplinkData.DevEUI) {
            setKnownDevEuis(prev => {
              const newSet = new Set(prev);
              newSet.add(uplinkData.DevEUI);
              return newSet;
            });
          }
        }
      } catch (e) {
        // Ignore parsing errors
      }
    });
  }, [messages]);

  const selectedPreset = useMemo(() =>
    COMMAND_PRESETS.find(p => p.name === selectedPresetName),
    [selectedPresetName]);

  // Strict Validation Effect
  useEffect(() => {
    setMissedSegError(null);
    if (!missedSegIndices) return;

    const parts = missedSegIndices.split(',').map(s => s.trim()).filter(s => s !== '');
    let hasSmall = false; // <= 255
    let hasLarge = false; // > 255

    for (const part of parts) {
      let num = 0;
      if (inputFormat === 'hex') {
        if (!/^[0-9A-Fa-f]+$/.test(part)) continue; // Skip incomplete typing
        num = parseInt(part, 16);
      } else {
        if (!/^\d+$/.test(part)) continue;
        num = parseInt(part, 10);
      }

      if (isNaN(num)) continue;

      if (num > 65535) {
        setMissedSegError(`Value ${part} exceeds 2 bytes (65535)`);
        return;
      }

      if (num > 255) hasLarge = true;
      else hasSmall = true;
    }

    if (hasSmall && hasLarge) {
      setMissedSegError("Cannot mix 1-byte (<=255) and 2-byte (>255) indices.");
      return;
    }

    if (missedSegSize === '00' && hasLarge) {
      setMissedSegError("Value > 255 requires 2-byte mode.");
      return;
    }

    if (missedSegSize === '01' && hasSmall) {
      setMissedSegError("Value <= 255 should use 1-byte mode.");
      return;
    }

  }, [missedSegIndices, missedSegSize, inputFormat]);

  // Calculate Payload
  const currentPayloadHex = useMemo(() => {
    if (!selectedPreset) return customPayload;

    if (selectedPreset.type === 'simple') {
      return selectedPreset.staticPayload || '';
    }

    if (selectedPreset.type === 'waveform_ack') {
      // 03 for TWI, 01 for TWD
      const cmdByte = selectedPreset.name.includes('TWI') ? '03' : '01';
      return `${cmdByte}${waveformTxId || '00'}`;
    }

    if (selectedPreset.type === 'missed_segments') {
      // Logic: Size (1 byte) + Count (1 byte) + Segments
      const parts = missedSegIndices.split(',')
        .map(s => s.trim())
        .filter(s => s !== '');

      const count = parts.length;
      const countHex = count.toString(16).padStart(2, '0').toUpperCase();

      // Parse and Pad indices based on size
      const paddedIndices = parts.map(part => {
        let val = 0;
        if (inputFormat === 'hex') {
          val = parseInt(part, 16);
        } else {
          val = parseInt(part, 10);
        }

        if (isNaN(val)) return ''; // Should be handled by validation, but safe fallback

        const hexVal = val.toString(16).toUpperCase();
        const targetLen = missedSegSize === '00' ? 2 : 4;
        return hexVal.padStart(targetLen, '0');
      }).join('');

      return `${missedSegSize}${countHex}${paddedIndices}`.toUpperCase();
    }

    return '';
  }, [selectedPreset, customPayload, waveformTxId, missedSegSize, missedSegIndices, inputFormat]);

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

  const generateCerts = async () => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
      const res = await fetch(`${apiUrl}/api/certs/client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId })
      });
      const data = await res.json();
      setCertResult(data);
    } catch (e) {
      console.error(e);
      alert('Error generating certs');
    }
  };

  return (
    <div className="flex h-screen bg-[#1e1e1e] text-gray-300 font-sans">
      {/* Sidebar */}
      <div className="w-16 bg-[#252526] flex flex-col items-center py-4 border-r border-[#333]">
        <button
          onClick={() => setActiveView('mqtt')}
          className={`p-3 mb-2 rounded-lg ${activeView === 'mqtt' ? 'bg-[#37373d] text-green-500' : 'hover:bg-[#2d2d2d]'}`}
          title="MQTT Connection"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </button>
        <button
          onClick={() => setActiveView('certs')}
          className={`p-3 mb-2 rounded-lg ${activeView === 'certs' ? 'bg-[#37373d] text-blue-500' : 'hover:bg-[#2d2d2d]'}`}
          title="Certificates"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="h-12 bg-[#252526] border-b border-[#333] flex items-center px-4 justify-between shrink-0">
          <h1 className="font-semibold text-sm text-gray-200">
            {activeView === 'mqtt' ? 'MQTT Monitor' : 'Certificate Management'}
          </h1>
          <div className="flex items-center space-x-2">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}></span>
            <span className="text-xs text-gray-500">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>

        {/* View Content */}
        <div className="flex-1 overflow-hidden relative">
          {activeView === 'mqtt' && (
            <div className="absolute inset-0 grid grid-cols-2 divide-x divide-[#333]">
              {/* Left Column: Message Log */}
              <div className="overflow-auto p-4 space-y-2">
                {messages.length === 0 && <div className="text-gray-500 text-center mt-10">No messages received yet.</div>}
                {messages.map((msg, idx) => (
                  <MQTTMessageCard
                    key={idx}
                    topic={msg.topic}
                    payload={msg.payload}
                    timestamp={msg.timestamp}
                  />
                ))}
              </div>

              {/* Right Column: Downlink Builder */}
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

                        {/* Hex/Decimal Toggle */}
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
                            onChange={(e) => setMissedSegSize(e.target.value as any)}
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
                      mosquitto_pub -h {host} -p 8883 -t "{topic.replace('[DevEUI]', devEui || '8C1F64...')}" -m '{getJsonPayload()}'
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
            </div>
          )}

          {activeView === 'certs' && (
            <div className="overflow-auto p-6 h-full">
              <div className="max-w-lg mx-auto bg-[#252526] p-6 rounded-lg border border-[#333]">
                <h2 className="text-lg font-medium mb-4 text-gray-200">Generate Client Certificate</h2>
                <div className="mb-4">
                  <label className="block text-xs text-gray-400 mb-1">Client ID / Device EUI</label>
                  <input
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded p-2 text-gray-200 focus:outline-none focus:border-blue-500"
                    placeholder="e.g. device-001"
                  />
                </div>
                <button
                  onClick={generateCerts}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded transition-colors"
                >
                  Generate & Sign
                </button>

                {certResult && (
                  <div className="mt-6 p-4 bg-[#1e1e1e] rounded border border-green-900">
                    <div className="text-green-500 mb-2">✓ {certResult.message}</div>
                    <div className="text-xs text-gray-400">
                      Files generated in <code>certs/</code> volume:
                      <ul className="list-disc pl-4 mt-1">
                        <li>{certResult.files?.key}</li>
                        <li>{certResult.files?.cert}</li>
                        <li>{certResult.files?.ca}</li>
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <SocketProvider>
      <AppContent />
    </SocketProvider>
  );
}
