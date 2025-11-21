"use client";

import { useState } from 'react';
import { SocketProvider, useSocket } from './SocketContext';

function AppContent() {
  const { connected, messages, socket } = useSocket();
  const [activeView, setActiveView] = useState<'mqtt' | 'certs'>('mqtt');
  const [clientId, setClientId] = useState('');
  const [certResult, setCertResult] = useState<any>(null);

  // Downlink Builder State
  const [topic, setTopic] = useState('mqtt/things/[DevEUI]/downlink');
  const [devEui, setDevEui] = useState('');
  const [fPort, setFPort] = useState('22');
  const [payloadHex, setPayloadHex] = useState('');
  const [host, setHost] = useState('');

  // Initialize host on mount
  useState(() => {
    if (typeof window !== 'undefined') {
      setHost(window.location.hostname);
    }
  });

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

  const getJsonPayload = () => {
    return JSON.stringify({
      DevEUI_downlink: {
        DevEUI: devEui || "8C1F642113000533",
        FPort: parseInt(fPort) || 22,
        payload_hex: payloadHex || "0002"
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
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
                  <div key={idx} className="bg-[#2d2d2d] p-3 rounded border border-[#3e3e42] font-mono text-xs">
                    <div className="flex justify-between text-gray-500 mb-1">
                      <span className="text-green-400">{msg.topic}</span>
                      <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-gray-300 break-all">{msg.payload}</div>
                  </div>
                ))}
              </div>

              {/* Right Column: Downlink Builder */}
              <div className="overflow-auto p-6 bg-[#1e1e1e]">
                <div className="space-y-6 max-w-xl">

                  {/* Broker Connection (Read Only) */}
                  <div className="bg-[#252526] p-4 rounded border border-[#333]">
                    <h3 className="text-xs font-semibold text-gray-400 uppercase mb-3">Broker Connection</h3>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2">
                        <label className="block text-[10px] text-gray-500 mb-1">HOST</label>
                        <input type="text" readOnly value={host} className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300" />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">PORT</label>
                        <input type="text" readOnly value="8883" className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300" />
                      </div>
                    </div>
                  </div>

                  {/* MQTT Message Config */}
                  <div className="bg-[#252526] p-4 rounded border border-[#333]">
                    <h3 className="text-xs font-semibold text-gray-400 uppercase mb-3">MQTT Message</h3>

                    <div className="mb-4">
                      <label className="block text-[10px] text-gray-500 mb-1">TOPIC</label>
                      <input
                        type="text"
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <div className="col-span-2">
                        <label className="block text-[10px] text-gray-500 mb-1">DevEUI</label>
                        <input
                          type="text"
                          value={devEui}
                          onChange={(e) => setDevEui(e.target.value)}
                          placeholder="8C1F64..."
                          className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-500 mb-1">FPort</label>
                        <input
                          type="text"
                          value={fPort}
                          onChange={(e) => setFPort(e.target.value)}
                          className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none"
                        />
                      </div>
                    </div>

                    <div className="mb-4">
                      <label className="block text-[10px] text-gray-500 mb-1">PAYLOAD (HEX)</label>
                      <input
                        type="text"
                        value={payloadHex}
                        onChange={(e) => setPayloadHex(e.target.value)}
                        placeholder="0002"
                        className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 outline-none font-mono"
                      />
                    </div>
                  </div>

                  {/* JSON Preview */}
                  <div className="bg-[#252526] p-4 rounded border border-[#333]">
                    <div className="flex justify-between items-center mb-2">
                      <h3 className="text-xs font-semibold text-gray-400 uppercase">MQTT Payload Preview</h3>
                      <button onClick={() => copyToClipboard(getJsonPayload())} className="text-[10px] text-blue-400 hover:text-blue-300">Copy JSON</button>
                    </div>
                    <pre className="bg-[#1e1e1e] p-2 rounded border border-[#3e3e42] text-[10px] text-green-400 font-mono overflow-x-auto">
                      {getJsonPayload()}
                    </pre>
                  </div>

                  {/* Command Preview */}
                  <div className="bg-[#252526] p-4 rounded border border-[#333]">
                    <div className="flex justify-between items-center mb-2">
                      <h3 className="text-xs font-semibold text-gray-400 uppercase">Mosquitto Pub Command</h3>
                      <button
                        onClick={() => {
                          const cmd = `mosquitto_pub -h ${host} -p 8883 -t "${topic.replace('[DevEUI]', devEui || '8C1F64...')}" -m '${getJsonPayload()}'`;
                          copyToClipboard(cmd);
                        }}
                        className="text-[10px] text-blue-400 hover:text-blue-300"
                      >
                        Copy Command
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
