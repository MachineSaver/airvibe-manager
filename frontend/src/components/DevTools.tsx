"use client";

import { useState } from 'react';
import SensorSimulator from './SensorSimulator';
import WaveformTracker from './WaveformTracker';
import CertificateManager from './CertificateManager';

type SubTab = 'simulator' | 'tracker' | 'certs';

export default function DevTools() {
  const [activeTab, setActiveTab] = useState<SubTab>('certs');

  const tabs: { key: SubTab; label: string }[] = [
    { key: 'certs', label: 'Certificates' },
    { key: 'simulator', label: 'Sensor Simulator' },
    { key: 'tracker', label: 'Waveform Tracker' },
  ];

  return (
    <div className="h-full flex flex-col bg-[var(--av-bg-base)]">
      {/* Sub-tab bar */}
      <div className="flex border-b border-[var(--av-border)] bg-[var(--av-bg-surface)] shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === t.key
                ? 'border-[var(--av-accent)] text-[var(--av-accent)]'
                : 'border-transparent text-[var(--av-text-subtle)] hover:text-[var(--av-text-muted)]'
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
