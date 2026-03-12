'use client';

import React, { useMemo } from 'react';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    ChartOptions
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend
);

export type ChartMode = 'time' | 'acceleration' | 'velocity' | 'psd' | 'envelope';

export interface SpectrumAxisData {
    axisNum: number;
    frequencies: number[];
    magnitudes: number[];
}

interface WaveformChartProps {
    // Time-domain props (mode = 'time')
    data?: { axis1: number[]; axis2: number[]; axis3: number[] };
    sampleRate?: number;
    // Shared
    mode: ChartMode;
    // Frequency-domain props (mode != 'time')
    spectrumAxes?: SpectrumAxisData[];
}

const AXIS_COLORS = ['#1f80ff', '#f97316', '#22c55e'];

const Y_AXIS_LABEL: Record<ChartMode, string> = {
    time:         'Acceleration (mg)',
    acceleration: 'Acceleration (g)',
    velocity:     'Velocity (mm/s)',
    psd:          'PSD (g²/Hz)',
    envelope:     'Acceleration (g)',
};

const WaveformChart: React.FC<WaveformChartProps> = ({
    data,
    sampleRate = 1,
    mode,
    spectrumAxes,
}) => {
    const chartData = useMemo(() => {
        if (mode === 'time' && data) {
            const length = Math.max(data.axis1.length, data.axis2.length, data.axis3.length);
            const labels = Array.from({ length }, (_, i) => (i / sampleRate).toFixed(4));
            const datasets = [];
            if (data.axis1.length > 0) datasets.push({
                label: 'Axis 1', data: data.axis1,
                borderColor: AXIS_COLORS[0], backgroundColor: AXIS_COLORS[0],
                borderWidth: 1, pointRadius: 0, tension: 0.1,
            });
            if (data.axis2.length > 0) datasets.push({
                label: 'Axis 2', data: data.axis2,
                borderColor: AXIS_COLORS[1], backgroundColor: AXIS_COLORS[1],
                borderWidth: 1, pointRadius: 0, tension: 0.1,
            });
            if (data.axis3.length > 0) datasets.push({
                label: 'Axis 3', data: data.axis3,
                borderColor: AXIS_COLORS[2], backgroundColor: AXIS_COLORS[2],
                borderWidth: 1, pointRadius: 0, tension: 0.1,
            });
            return { labels, datasets };
        }

        // Frequency-domain
        if (!spectrumAxes || spectrumAxes.length === 0) return { labels: [], datasets: [] };

        // All axes share the same frequency axis (same fs, same N) — use axis[0]
        const labels = spectrumAxes[0].frequencies.map(f => f.toFixed(2));
        const datasets = spectrumAxes.map((ax, i) => ({
            label: `Axis ${ax.axisNum}`,
            data: ax.magnitudes,
            borderColor: AXIS_COLORS[i % AXIS_COLORS.length],
            backgroundColor: AXIS_COLORS[i % AXIS_COLORS.length],
            borderWidth: 1,
            pointRadius: 0,
            tension: 0,
        }));
        return { labels, datasets };
    }, [data, sampleRate, mode, spectrumAxes]);

    const xMax = useMemo(() => {
        if (mode === 'velocity' && spectrumAxes && spectrumAxes.length > 0) {
            const nyquist = spectrumAxes[0].frequencies[spectrumAxes[0].frequencies.length - 1];
            return Math.min(1000, nyquist);
        }
        return undefined;
    }, [mode, spectrumAxes]);

    const options: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        plugins: {
            legend: {
                position: 'top' as const,
                labels: { color: '#cbd5e1' },
            },
            title: { display: false },
            tooltip: { enabled: true },
        },
        scales: {
            x: {
                ticks: {
                    color: '#94a3b8',
                    maxTicksLimit: 10,
                    callback: function (val, index) {
                        // Show every Nth label to avoid crowding
                        return this.getLabelForValue(index as number);
                    },
                },
                grid: { color: '#334155' },
                title: {
                    display: true,
                    text: mode === 'time' ? 'Time (s)' : 'Frequency (Hz)',
                    color: '#94a3b8',
                },
                ...(xMax !== undefined ? { max: String(xMax.toFixed(2)) } : {}),
            },
            y: {
                ticks: { color: '#94a3b8' },
                grid: { color: '#334155' },
                title: {
                    display: true,
                    text: Y_AXIS_LABEL[mode],
                    color: '#94a3b8',
                },
            },
        },
    };

    return (
        <div className="w-full h-[400px] bg-slate-950 p-4 rounded-xl border border-slate-800">
            <Line options={options} data={chartData} />
        </div>
    );
};

export default WaveformChart;
