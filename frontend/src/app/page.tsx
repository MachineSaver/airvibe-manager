"use client";

import { useState } from 'react';
import { SocketProvider, useSocket } from './SocketContext';

function AppContent() {
  const { connected, messages } = useSocket();
  const [activeView, setActiveView] = useState<'mqtt' | 'certs'>('mqtt');
  const [clientId, setClientId] = useState('');
  const [certResult, setCertResult] = useState<any>(null);

  const generateCerts = async () => {
    try {
      const res = await fetch('http://localhost:4000/api/certs/client', {
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
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="h-12 bg-[#252526] border-b border-[#333] flex items-center px-4 justify-between">
          <h1 className="font-semibold text-sm text-gray-200">
            {activeView === 'mqtt' ? 'MQTT Monitor' : 'Certificate Management'}
          </h1>
          <div className="flex items-center space-x-2">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}></span>
            <span className="text-xs text-gray-500">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>

        {/* View Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeView === 'mqtt' && (
            <div className="space-y-2">
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
          )}

          {activeView === 'certs' && (
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
