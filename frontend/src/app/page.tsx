"use client";

import { useState } from 'react';
import { SocketProvider, useSocket } from './SocketContext';
import { SettingsProvider } from '@/contexts/SettingsContext';
import MQTTMonitor from '@/components/MQTTMonitor';
import WaveformsView from '@/components/WaveformsView';
import FUOTAManager from '@/components/FUOTAManager';
import DevTools from '@/components/DevTools';
import Historian from '@/components/Historian';
import Settings from '@/components/Settings';

type ViewId = 'mqtt' | 'waveforms' | 'fuota' | 'devtools' | 'historian' | 'docs' | 'settings';

function AppContent() {
  const { connected, messages, socket } = useSocket();
  const [activeView, setActiveView] = useState<ViewId>('mqtt');
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  const VIEW_TITLE: Record<ViewId, string> = {
    mqtt:      'MQTT Live Data',
    waveforms: 'Waveform Manager',
    fuota:     'FUOTA Manager',
    devtools:  'Dev Tools',
    historian: 'Historian',
    docs:      'API Documentation',
    settings:  'Settings',
  };

  // Shared sidebar button styles driven by design tokens
  const navBtn = (view: ViewId, extraMt = '') => {
    const isActive = activeView === view;
    return `relative flex items-center justify-center w-10 h-10 mb-1 rounded-lg transition-colors duration-150 ${extraMt} ${
      isActive
        ? 'bg-[var(--av-bg-raised)] text-[var(--av-accent)]'
        : 'text-[var(--av-text-subtle)] hover:bg-[var(--av-bg-hover)] hover:text-[var(--av-text-muted)]'
    }`;
  };

  return (
    <div className="flex h-screen bg-[var(--av-bg-base)] text-[var(--av-text-primary)]">
      {/* Sidebar */}
      <div className="w-16 bg-[var(--av-bg-surface)] flex flex-col items-center py-3 border-r border-[var(--av-border)] shrink-0">

        {/* MQTT Live Data */}
        <button onClick={() => setActiveView('mqtt')} className={navBtn('mqtt')} title="MQTT Live Data">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </button>

        {/* Waveforms */}
        <button onClick={() => setActiveView('waveforms')} className={navBtn('waveforms')} title="Waveform Manager">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </button>

        {/* FUOTA */}
        <button onClick={() => setActiveView('fuota')} className={navBtn('fuota')} title="FUOTA Manager">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        </button>

        {/* Dev Tools */}
        <button onClick={() => setActiveView('devtools')} className={navBtn('devtools')} title="Dev Tools">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        </button>

        {/* Historian */}
        <button onClick={() => setActiveView('historian')} className={navBtn('historian')} title="Historian">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>

        {/* API Docs */}
        <button onClick={() => setActiveView('docs')} className={navBtn('docs')} title="API Documentation">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.747 0-3.332.477-4.5 1.253" />
          </svg>
        </button>

        {/* Settings — pinned to bottom */}
        <button onClick={() => setActiveView('settings')} className={navBtn('settings', 'mt-auto')} title="Settings">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="h-12 bg-[var(--av-bg-surface)] border-b border-[var(--av-border)] flex items-center px-4 justify-between shrink-0">
          <h1 className="font-semibold text-sm text-[var(--av-text-primary)] tracking-wide">{VIEW_TITLE[activeView]}</h1>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${
            connected
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>

        {/* View Content */}
        <div className="flex-1 overflow-hidden relative">
          {activeView === 'mqtt' && (
            <div className="absolute inset-0 overflow-auto">
              <MQTTMonitor messages={messages} socket={socket} />
            </div>
          )}
          {activeView === 'waveforms' && <WaveformsView />}
          {activeView === 'fuota'     && <FUOTAManager socket={socket} />}
          {activeView === 'devtools'  && <DevTools />}
          {activeView === 'historian' && <Historian />}
          {activeView === 'settings'  && <Settings />}
          {activeView === 'docs' && (
            <iframe
              src={`${apiUrl}/api/docs/`}
              className="absolute inset-0 w-full h-full border-0"
              title="API Documentation"
            />
          )}
        </div>

        {/* Build Info Footer */}
        <div className="h-7 flex items-center justify-center border-t border-[var(--av-border)] bg-[var(--av-bg-surface)] shrink-0">
          <span className="text-[11px] text-[var(--av-text-subtle)] font-mono tracking-wide">
            build {process.env.NEXT_PUBLIC_BUILD_HASH} &bull; {process.env.NEXT_PUBLIC_BUILD_DATE} UTC
          </span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <SettingsProvider>
      <SocketProvider>
        <AppContent />
      </SocketProvider>
    </SettingsProvider>
  );
}
