"use client";

import { useState } from 'react';
import { SocketProvider, useSocket } from './SocketContext';
import MQTTMonitor from '@/components/MQTTMonitor';
import DownlinkBuilder from '@/components/DownlinkBuilder';
import CertificateManager from '@/components/CertificateManager';
import WaveformsView from '@/components/WaveformsView';
import WaveformTracker from '@/components/WaveformTracker';

function AppContent() {
  const { connected, messages, socket } = useSocket();
  const [activeView, setActiveView] = useState<'mqtt' | 'certs' | 'waveforms' | 'tracker'>('mqtt');

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
        <button
          onClick={() => setActiveView('waveforms')}
          className={`p-3 mb-2 rounded-lg ${activeView === 'waveforms' ? 'bg-[#37373d] text-purple-500' : 'hover:bg-[#2d2d2d]'}`}
          title="Waveforms"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </button>
        <button
          onClick={() => setActiveView('tracker')}
          className={`p-3 mb-2 rounded-lg ${activeView === 'tracker' ? 'bg-[#37373d] text-orange-500' : 'hover:bg-[#2d2d2d]'}`}
          title="Waveform Tracker"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
          </svg>
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="h-12 bg-[#252526] border-b border-[#333] flex items-center px-4 justify-between shrink-0">
          <h1 className="font-semibold text-sm text-gray-200">
            {activeView === 'mqtt' ? 'MQTT Monitor' : activeView === 'certs' ? 'Certificate Management' : activeView === 'waveforms' ? 'Waveform Manager' : 'Waveform Tracker'}
          </h1>
          <div className="flex items-center space-x-2">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}></span>
            <span className="text-xs text-gray-500">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>

        {/* View Content */}
        <div className="flex-1 overflow-hidden relative">
          {activeView === 'mqtt' && (
            <div className="absolute inset-0 grid grid-cols-1 md:grid-cols-2 md:divide-x divide-[#333]">
              <MQTTMonitor messages={messages} />
              <DownlinkBuilder socket={socket} messages={messages} />
            </div>
          )}

          {activeView === 'certs' && <CertificateManager />}

          {activeView === 'waveforms' && <WaveformsView />}

          {activeView === 'tracker' && <WaveformTracker />}
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
