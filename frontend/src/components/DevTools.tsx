"use client";

import { useState } from 'react';
import SensorSimulator from './SensorSimulator';
import WaveformTracker from './WaveformTracker';
import CertificateManager from './CertificateManager';

type SubTab = 'simulator' | 'tracker' | 'certs';

export default function DevTools() {
  const [activeTab, setActiveTab] = useState<SubTab>('simulator');

  const tabs: { key: SubTab; label: string }[] = [
    { key: 'simulator', label: 'Sensor Simulator' },
    { key: 'tracker', label: 'Waveform Tracker' },
    { key: 'certs', label: 'Certificates' },
  ];

  return (
    <div className="h-full flex flex-col bg-[#1e1e1e]">
      {/* Sub-tab bar */}
      <div className="flex border-b border-[#333] bg-[#252526] shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === t.key
                ? 'border-cyan-500 text-cyan-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'simulator' && <SensorSimulator />}
        {activeTab === 'tracker' && <WaveformTracker />}
        {activeTab === 'certs' && <CertificateManager />}
      </div>
    </div>
  );
}
