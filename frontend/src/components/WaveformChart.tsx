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

interface WaveformChartProps {
    data: {
        axis1: number[];
        axis2: number[];
        axis3: number[];
    };
    sampleRate: number;
}

const WaveformChart: React.FC<WaveformChartProps> = ({ data, sampleRate }) => {
    const chartData = useMemo(() => {
        // Generate labels based on sample rate (Time in seconds)
        // Assuming all axes have same length
        const length = Math.max(data.axis1.length, data.axis2.length, data.axis3.length);
        const labels = Array.from({ length }, (_, i) => (i / sampleRate).toFixed(4));

        const datasets = [];

        // Only add datasets for axes that have data
        if (data.axis1.length > 0) {
            datasets.push({
                label: 'Axis 1',
                data: data.axis1,
                borderColor: '#00357a',
                backgroundColor: '#00357a',
                borderWidth: 1,
                pointRadius: 0,
                tension: 0.1,
            });
        }

        if (data.axis2.length > 0) {
            datasets.push({
                label: 'Axis 2',
                data: data.axis2,
                borderColor: '#1f80ff',
                backgroundColor: '#1f80ff',
                borderWidth: 1,
                pointRadius: 0,
                tension: 0.1,
            });
        }

        if (data.axis3.length > 0) {
            datasets.push({
                label: 'Axis 3',
                data: data.axis3,
                borderColor: '#c2dcff',
                backgroundColor: '#c2dcff',
                borderWidth: 1,
                pointRadius: 0,
                tension: 0.1,
            });
        }

        return { labels, datasets };
    }, [data, sampleRate]);

    const options: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false, // Disable animation for performance with large datasets
        interaction: {
            mode: 'index',
            intersect: false,
        },
        plugins: {
            legend: {
                position: 'top' as const,
                labels: { color: '#cbd5e1' }
            },
            title: {
                display: false,
            },
            tooltip: {
                enabled: true, // Might want to disable for 16k points if laggy
            }
        },
        scales: {
            x: {
                ticks: { color: '#94a3b8', maxTicksLimit: 10 },
                grid: { color: '#334155' }
            },
            y: {
                ticks: { color: '#94a3b8' },
                grid: { color: '#334155' },
                title: { display: true, text: 'Acceleration (mg)', color: '#94a3b8' }
            }
        }
    };

    return (
        <div className="w-full h-[400px] bg-slate-950 p-4 rounded-xl border border-slate-800">
            <Line options={options} data={chartData} />
        </div>
    );
};

export default WaveformChart;
