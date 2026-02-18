'use client';

import React, { useEffect, useState, useCallback } from 'react';
import SegmentMap from './SegmentMap';
import WaveformChart from './WaveformChart';
import { deinterleaveWaveform } from '@/lib/deinterleave';

interface Waveform {
    id: string;
    device_eui: string;
    transaction_id: number;
    start_time: string;
    status: string;
    expected_segments: number;
    received_segments_count: number;
    metadata?: {
        sampleRate: number;
        samplesPerAxis: number;
        axisSelection: string;
        axisMask: number;
        numSegments: number;
        hwFilter: string;
        errorCode: number;
    };
    final_data?: { raw_hex: string };
    segments?: number[];
    requested_segments?: number[];
}

function processChartData(wf: Waveform): { axis1: number[], axis2: number[], axis3: number[] } | null {
    if (!wf.final_data?.raw_hex || !wf.metadata) return null;
    return deinterleaveWaveform(wf.final_data.raw_hex, wf.metadata.axisMask);
}

function formatAxisLabel(axisSelection: string, axisMask: number): string {
    const axes: string[] = [];
    if (axisMask & 0x01) axes.push('Axis 1');
    if (axisMask & 0x02) axes.push('Axis 2');
    if (axisMask & 0x04) axes.push('Axis 3');
    return `${axes.join(', ')} (${axisSelection})`;
}

interface Device {
    dev_eui: string;
    uplink_count: number;
    downlink_count: number;
    last_seen: string;
}

export default function WaveformsView() {
    const [waveforms, setWaveforms] = useState<Waveform[]>([]);
    const [devices, setDevices] = useState<Device[]>([]);
    const [selectedEui, setSelectedEui] = useState<string | null>(null);
    const [expandedEui, setExpandedEui] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedWaveform, setSelectedWaveform] = useState<Waveform | null>(null);
    const [chartData, setChartData] = useState<{ axis1: number[], axis2: number[], axis3: number[] } | null>(null);

    const fetchDevices = useCallback(async () => {
        try {
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
            const res = await fetch(`${apiUrl}/api/devices`);
            setDevices(await res.json());
        } catch {
            // silently ignore
        }
    }, []);

    const fetchWaveforms = useCallback(async () => {
        try {
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
            const res = await fetch(`${apiUrl}/api/waveforms`);
            const data = await res.json();
            setWaveforms(data);
        } catch (err) {
            console.error('Failed to fetch waveforms', err);
        }
    }, []);

    const fetchWaveformDetail = useCallback(async (id: string) => {
        try {
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
            const res = await fetch(`${apiUrl}/api/waveforms/${id}`);
            const data = await res.json();
            setSelectedWaveform(data);

            if (data.status === 'complete' && data.final_data?.raw_hex) {
                setChartData(processChartData(data));
            } else {
                setChartData(null);
            }
        } catch (err) {
            console.error('Failed to fetch detail', err);
        }
    }, []);

    useEffect(() => {
        const timeout = setTimeout(fetchWaveforms, 0);
        const interval = setInterval(fetchWaveforms, 2000);
        return () => { clearTimeout(timeout); clearInterval(interval); };
    }, [fetchWaveforms]);

    useEffect(() => {
        const timeout = setTimeout(fetchDevices, 0);
        const interval = setInterval(fetchDevices, 5000);
        return () => { clearTimeout(timeout); clearInterval(interval); };
    }, [fetchDevices]);

    // Derive effective selected ID: if a device is selected but no explicit transaction
    // was picked, auto-select the best one (active > most recent)
    const effectiveSelectedId = (() => {
        if (selectedId) {
            // Validate that selectedId still belongs to the selected device (or no device filter)
            if (!selectedEui) return selectedId;
            const wf = waveforms.find(w => w.id === selectedId);
            if (wf && wf.device_eui === selectedEui) return selectedId;
        }
        if (!selectedEui) return null;
        const deviceWaveforms = waveforms.filter(wf => wf.device_eui === selectedEui);
        if (deviceWaveforms.length === 0) return null;
        const active = deviceWaveforms.find(wf => wf.status !== 'complete' && wf.status !== 'aborted');
        return active ? active.id : deviceWaveforms[0].id;
    })();

    useEffect(() => {
        if (effectiveSelectedId) {
            const timeout = setTimeout(() => fetchWaveformDetail(effectiveSelectedId), 0);
            const interval = setInterval(() => fetchWaveformDetail(effectiveSelectedId), 2000);
            return () => { clearTimeout(timeout); clearInterval(interval); };
        } else {
            const timeout = setTimeout(() => {
                setSelectedWaveform(null);
                setChartData(null);
            }, 0);
            return () => clearTimeout(timeout);
        }
    }, [effectiveSelectedId, fetchWaveformDetail]);

    const handleDeviceClick = (devEui: string) => {
        setSelectedEui(devEui);
        setSelectedId(null); // Reset so auto-select picks the best transaction
    };

    const handleChevronClick = (e: React.MouseEvent, devEui: string) => {
        e.stopPropagation();
        setExpandedEui(prev => prev === devEui ? null : devEui);
    };

    const handleTransactionClick = (wfId: string, devEui: string) => {
        setSelectedEui(devEui);
        setSelectedId(wfId);
    };

    return (
        <div className="flex flex-col md:flex-row h-full bg-[#1e1e1e] text-gray-300 font-sans overflow-hidden">
            {/* Device Sidebar */}
            <div className="w-full md:w-72 border-b md:border-b-0 md:border-r border-[#333] flex flex-col shrink-0 max-h-64 md:max-h-none">
                <div className="p-3 border-b border-[#333] bg-[#252526]">
                    <h2 className="text-xs font-semibold text-gray-200">Devices</h2>
                </div>
                <div className="overflow-y-auto flex-1 p-1.5 space-y-1">
                    {devices.length === 0 && (
                        <div className="text-gray-500 text-center mt-4 text-xs">No devices found.</div>
                    )}
                    {devices.map(d => {
                        const isSelected = selectedEui === d.dev_eui;
                        const isExpanded = expandedEui === d.dev_eui;
                        const deviceWaveforms = waveforms.filter(wf => wf.device_eui === d.dev_eui);

                        return (
                            <div key={d.dev_eui}>
                                {/* Device card row */}
                                <div
                                    onClick={() => handleDeviceClick(d.dev_eui)}
                                    className={`flex items-center cursor-pointer rounded transition-colors ${isSelected ? 'bg-blue-600/30 text-blue-300 border border-blue-500/50' : 'text-gray-400 hover:bg-[#2a2a2b] border border-transparent'}`}
                                >
                                    <div className="flex-1 px-2 py-1.5 min-w-0">
                                        <div className="font-mono text-[10px] truncate">{d.dev_eui}</div>
                                        <div className="flex gap-2 text-[9px] mt-0.5">
                                            <span style={{ color: '#0d9488' }}>↑{d.uplink_count}</span>
                                            <span style={{ color: '#9333ea' }}>↓{d.downlink_count}</span>
                                        </div>
                                    </div>
                                    {/* Chevron toggle */}
                                    {deviceWaveforms.length > 0 && (
                                        <button
                                            onClick={(e) => handleChevronClick(e, d.dev_eui)}
                                            className="flex items-center justify-center min-w-[44px] min-h-[44px] shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
                                            aria-label={isExpanded ? 'Collapse transactions' : 'Expand transactions'}
                                        >
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                className={`h-3.5 w-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                                                viewBox="0 0 20 20"
                                                fill="currentColor"
                                            >
                                                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                                            </svg>
                                        </button>
                                    )}
                                </div>

                                {/* Expanded transaction history */}
                                {isExpanded && (
                                    <div className="pl-3 space-y-1 mt-1 max-h-[280px] overflow-y-auto">
                                        {deviceWaveforms.length === 0 && (
                                            <div className="text-gray-500 text-[10px] px-2 py-1">No transactions</div>
                                        )}
                                        {deviceWaveforms.map(wf => (
                                            <div
                                                key={wf.id}
                                                onClick={() => handleTransactionClick(wf.id, d.dev_eui)}
                                                className={`px-2 py-1.5 rounded cursor-pointer transition-colors ${effectiveSelectedId === wf.id ? 'bg-[#37373d] border border-blue-500/50' : 'bg-[#252526] border border-[#333] hover:bg-[#2a2a2b]'}`}
                                            >
                                                <div className="flex justify-between items-center">
                                                    <span className="font-mono text-blue-400 font-bold text-[10px]">#{wf.transaction_id}</span>
                                                    <span className={`text-[9px] px-1 py-0.5 rounded-full uppercase ${wf.status === 'complete' ? 'bg-green-900/50 text-green-400' : wf.status === 'aborted' ? 'bg-red-900/50 text-red-400' : 'bg-yellow-900/50 text-yellow-400'}`}>
                                                        {wf.status}
                                                    </span>
                                                </div>
                                                <div className="w-full bg-[#1e1e1e] rounded-full h-1 overflow-hidden mt-1">
                                                    <div
                                                        className="bg-blue-500 h-full transition-all duration-500"
                                                        style={{ width: `${(wf.received_segments_count / (wf.expected_segments || 1)) * 100}%` }}
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Detail Panel */}
            <div className="flex-1 flex flex-col overflow-y-auto p-6 gap-6">
                {selectedWaveform ? (
                    <>
                        <div className="bg-[#252526] rounded border border-[#333] p-6">
                            <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                                <div>
                                    <h1 className="text-xl font-bold text-white mb-1">
                                        Transaction #{selectedWaveform.transaction_id}
                                    </h1>
                                    <div className="flex flex-wrap gap-4 text-xs text-gray-400">
                                        <span>DevEUI: <span className="font-mono text-gray-300">{selectedWaveform.device_eui}</span></span>
                                        <span>Started: {new Date(selectedWaveform.start_time).toLocaleTimeString()}</span>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-2xl font-mono font-bold text-blue-400">
                                        {selectedWaveform.received_segments_count} <span className="text-sm text-gray-500">/ {selectedWaveform.expected_segments}</span>
                                    </div>
                                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Segments</div>
                                    {selectedWaveform.status === 'complete' && (
                                        <div className="flex flex-wrap gap-2">
                                            <button
                                                onClick={() => {
                                                    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
                                                    window.open(`${apiUrl}/api/waveforms/${selectedWaveform.id}/download`, '_blank');
                                                }}
                                                className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded text-xs font-semibold transition-colors flex items-center gap-1"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                                                    <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
                                                </svg>
                                                Download JSON
                                            </button>
                                            <button
                                                onClick={() => {
                                                    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
                                                    window.open(`${apiUrl}/api/waveforms/${selectedWaveform.id}/csv`, '_blank');
                                                }}
                                                className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded text-xs font-semibold transition-colors flex items-center gap-1"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                                                    <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
                                                </svg>
                                                Download CSV
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {selectedWaveform.metadata && (
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4 pt-4 border-t border-[#333]">
                                    <div>
                                        <div className="text-[10px] text-gray-500 mb-1">Sample Rate</div>
                                        <div className="font-mono text-gray-300 text-sm">{selectedWaveform.metadata.sampleRate} Hz</div>
                                    </div>
                                    <div>
                                        <div className="text-[10px] text-gray-500 mb-1">Samples/Axis</div>
                                        <div className="font-mono text-gray-300 text-sm">{selectedWaveform.metadata.samplesPerAxis}</div>
                                    </div>
                                    <div>
                                        <div className="text-[10px] text-gray-500 mb-1">Axes</div>
                                        <div className="font-mono text-gray-300 text-sm">{formatAxisLabel(selectedWaveform.metadata.axisSelection, selectedWaveform.metadata.axisMask)}</div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="bg-[#252526] rounded border border-[#333] p-4">
                            <h3 className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wider">Ingestion Map</h3>
                            <SegmentMap
                                totalSegments={selectedWaveform.expected_segments || 0}
                                receivedSegments={selectedWaveform.segments || []}
                                missingRequested={selectedWaveform.requested_segments || []}
                                finalSegmentSeen={
                                    selectedWaveform.status === 'complete' ||
                                    (selectedWaveform.segments || []).includes((selectedWaveform.expected_segments || 0) - 1)
                                }
                            />
                        </div>

                        {chartData && selectedWaveform.metadata ? (
                            <div className="bg-[#252526] rounded border border-[#333] p-4 flex-1 min-h-[400px]">
                                <h3 className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wider">Waveform Data</h3>
                                <WaveformChart
                                    data={chartData}
                                    sampleRate={selectedWaveform.metadata.sampleRate}
                                />
                            </div>
                        ) : (
                            <div className="bg-[#252526] rounded border border-[#333] p-12 flex items-center justify-center text-gray-500 flex-1 text-sm">
                                {selectedWaveform.status === 'complete' ? 'Processing visualization...' : 'Waiting for completion to visualize waveform...'}
                            </div>
                        )}
                    </>
                ) : (
                    <div className="h-full flex items-center justify-center text-gray-500 text-sm">
                        Select a device to view details
                    </div>
                )}
            </div>
        </div>
    );
}
