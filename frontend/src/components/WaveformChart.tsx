'use client';

import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useSettings, AccelUnit, VelocityUnit } from '@/contexts/SettingsContext';

// Dynamic import — Plotly uses browser APIs, must be client-only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = dynamic(() => import('react-plotly.js'), { ssr: false }) as React.FC<any>;

export type ChartMode = 'time' | 'acceleration' | 'velocity' | 'psd' | 'envelope';

export interface SpectrumAxisData {
    axisNum:     number;
    frequencies: number[];
    magnitudes:  number[];
}

interface WaveformChartProps {
    mode:           ChartMode;
    data?:          { axis1: number[]; axis2: number[]; axis3: number[] };
    sampleRate?:    number;
    spectrumAxes?:  SpectrumAxisData[];
    /** Override the X-axis display range (Hz). When provided, takes precedence over settings frequency ranges. */
    xRangeHz?:      [number, number];
}

// ── Axis palette ─────────────────────────────────────────────────────────────
const AXIS_COLORS = ['#1f80ff', '#f97316', '#22c55e'];

// ── Unit conversion factors ───────────────────────────────────────────────────
// Time-domain input: mg
const ACCEL_FROM_MG: Record<AccelUnit, number> = {
    'g':        1 / 1000,
    'mg':       1,
    'm/s²':     9.81  / 1000,
    'mm/s²':    9810  / 1000,
    'inch/s²':  386.09 / 1000,
};

// Spectrum input: g (peak)
const ACCEL_FROM_G: Record<AccelUnit, number> = {
    'g':        1,
    'mg':       1000,
    'm/s²':     9.81,
    'mm/s²':    9810,
    'inch/s²':  386.09,
};

// PSD input: g²/Hz
const PSD_FROM_G2: Record<AccelUnit, number> = {
    'g':        1,
    'mg':       1e6,
    'm/s²':     9.81 ** 2,
    'mm/s²':    9810 ** 2,
    'inch/s²':  386.09 ** 2,
};

// Velocity input: mm/s (peak)
const VEL_FROM_MMS: Record<VelocityUnit, number> = {
    'mm/s':   1,
    'inch/s': 1 / 25.4,
};

const RMS_FACTOR = 1 / Math.SQRT2;

// ── Plotly dark-theme ─────────────────────────────────────────────────────────
const DARK_BG  = '#0f172a';
const GRID_COL = '#1e293b';
const TICK_COL = '#94a3b8';
const AXIS_COL = '#64748b';

function baseLayout(xLabel: string, yLabel: string, xRange?: [number, number]) {
    return {
        paper_bgcolor: DARK_BG,
        plot_bgcolor:  DARK_BG,
        font:   { color: TICK_COL, family: 'ui-monospace, SFMono-Regular, Menlo, monospace', size: 11 },
        margin: { l: 72, r: 24, t: 32, b: 56 },
        legend: {
            font: { color: '#cbd5e1', size: 11 },
            bgcolor: 'rgba(0,0,0,0)',
            orientation: 'h' as const,
            y: 1.06, xanchor: 'left', x: 0,
        },
        xaxis: {
            title:      { text: xLabel, font: { color: AXIS_COL }, standoff: 8 },
            gridcolor:  GRID_COL,
            zerolinecolor: GRID_COL,
            color:      TICK_COL,
            tickfont:   { color: TICK_COL, size: 10 },
            linecolor:  AXIS_COL,
            ...(xRange ? { range: xRange } : {}),
        },
        yaxis: {
            title:      { text: yLabel, font: { color: AXIS_COL }, standoff: 8 },
            gridcolor:  GRID_COL,
            zerolinecolor: GRID_COL,
            color:      TICK_COL,
            tickfont:   { color: TICK_COL, size: 10 },
            linecolor:  AXIS_COL,
            rangemode:  'tozero' as const,
            autorange:  true,
        },
        hovermode:  'x unified' as const,
        hoverlabel: {
            bgcolor:     '#1e293b',
            font:        { color: '#e2e8f0', size: 11 },
            bordercolor: '#475569',
        },
        autosize: true,
    };
}

// Mutates layout to overlay a CPM axis on top of an Hz primary axis.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addCpmAxis(layout: any, hzRange: [number, number]) {
    layout.xaxis2 = {
        title:     { text: 'CPM', font: { color: AXIS_COL }, standoff: 8 },
        overlaying: 'x',
        side:      'top',
        range:     [hzRange[0] * 60, hzRange[1] * 60],
        gridcolor: 'transparent',
        showgrid:  false,
        color:     TICK_COL,
        tickfont:  { color: TICK_COL, size: 10 },
        linecolor: AXIS_COL,
    };
}

const PLOT_CONFIG = {
    displayModeBar: true,
    modeBarButtonsToRemove: ['sendDataToCloud', 'lasso2d', 'select2d', 'autoScale2d'],
    displaylogo: false,
    responsive:  true,
    toImageButtonOptions: { format: 'png', scale: 2 },
};

// ── Component ──────────────────────────────────────────────────────────────────
const WaveformChart: React.FC<WaveformChartProps> = ({
    mode,
    data,
    sampleRate = 1,
    spectrumAxes,
    xRangeHz,
}) => {
    const { settings } = useSettings();

    const { traces, layout } = useMemo(() => {
        const {
            accelUnit, accelNorm, velocityUnit, velocityNorm, freqUnit,
            velocityFreqMin, velocityFreqMax,
            accelFreqMin, accelFreqMax,
            envelopeFreqMin, envelopeFreqMax,
        } = settings;

        const rms = (norm: 'peak' | 'rms') => norm === 'rms' ? RMS_FACTOR : 1;

        const toFreqX  = (f: number) => freqUnit === 'CPM' ? f * 60 : f;
        const xAxisLbl = freqUnit === 'CPM' ? 'Frequency (CPM)' : 'Frequency (Hz)';
        const freqRange = (minHz: number, maxHz: number): [number, number] =>
            freqUnit === 'CPM' ? [minHz * 60, maxHz * 60] : [minHz, maxHz];

        // ── Time domain ────────────────────────────────────────────────────
        // Note: accelNorm (peak/RMS) is a spectral concept and does NOT apply
        // to instantaneous time-domain samples — only unit conversion is used.
        if (mode === 'time' && data) {
            const conv = ACCEL_FROM_MG[accelUnit];
            const axes = [
                { arr: data.axis1, label: 'Axis 1' },
                { arr: data.axis2, label: 'Axis 2' },
                { arr: data.axis3, label: 'Axis 3' },
            ].filter(a => a.arr.length > 0);
            const n  = axes[0]?.arr.length ?? 0;
            const t  = Array.from({ length: n }, (_, i) => +(i / sampleRate).toFixed(5));
            const traces = axes.map((ax, i) => ({
                x: t,
                y: ax.arr.map(v => v * conv),
                type: 'scatter',
                mode: 'lines',
                name: ax.label,
                line: { color: AXIS_COLORS[i % 3], width: 1 },
                hovertemplate: `%{y:.4g} ${accelUnit}<extra>${ax.label}</extra>`,
            }));
            return { traces, layout: baseLayout('Time (s)', `Acceleration (${accelUnit})`) };
        }

        if (!spectrumAxes || spectrumAxes.length === 0) {
            return { traces: [], layout: baseLayout('', '') };
        }

        // ── Acceleration spectrum ─────────────────────────────────────────
        if (mode === 'acceleration') {
            const conv   = ACCEL_FROM_G[accelUnit] * rms(accelNorm);
            const xRange = freqRange(accelFreqMin, accelFreqMax);
            const traces = spectrumAxes.map((ax, i) => ({
                x: ax.frequencies.map(toFreqX),
                y: ax.magnitudes.map(v => v * conv),
                type: 'scatter', mode: 'lines',
                name: `Axis ${ax.axisNum}`,
                line: { color: AXIS_COLORS[i % 3], width: 1 },
                hovertemplate: `%{y:.4g} ${accelUnit}<extra>Axis ${ax.axisNum}</extra>`,
            }));
            const yLbl = `Acceleration (${accelUnit}${accelNorm === 'rms' ? ' RMS' : ' peak'})`;
            const lay  = baseLayout(xAxisLbl, yLbl, xRange);
            if (freqUnit === 'Hz + CPM') addCpmAxis(lay, xRange);
            return { traces, layout: lay };
        }

        // ── Velocity spectrum ─────────────────────────────────────────────
        if (mode === 'velocity') {
            const conv   = VEL_FROM_MMS[velocityUnit] * rms(velocityNorm);
            const xRange = freqRange(velocityFreqMin, velocityFreqMax);
            const traces = spectrumAxes.map((ax, i) => ({
                x: ax.frequencies.map(toFreqX),
                y: ax.magnitudes.map(v => v * conv),
                type: 'scatter', mode: 'lines',
                name: `Axis ${ax.axisNum}`,
                line: { color: AXIS_COLORS[i % 3], width: 1 },
                hovertemplate: `%{y:.4g} ${velocityUnit}<extra>Axis ${ax.axisNum}</extra>`,
            }));
            const yLbl = `Velocity (${velocityUnit}${velocityNorm === 'rms' ? ' RMS' : ' peak'})`;
            const lay  = baseLayout(xAxisLbl, yLbl, xRange);
            if (freqUnit === 'Hz + CPM') addCpmAxis(lay, xRange);
            return { traces, layout: lay };
        }

        // ── PSD ───────────────────────────────────────────────────────────
        if (mode === 'psd') {
            const conv   = PSD_FROM_G2[accelUnit];
            const xRange = freqRange(accelFreqMin, accelFreqMax);
            const traces = spectrumAxes.map((ax, i) => ({
                x: ax.frequencies.map(toFreqX),
                y: ax.magnitudes.map(v => v * conv),
                type: 'scatter', mode: 'lines',
                name: `Axis ${ax.axisNum}`,
                line: { color: AXIS_COLORS[i % 3], width: 1 },
                hovertemplate: `%{y:.4g} ${accelUnit}²/Hz<extra>Axis ${ax.axisNum}</extra>`,
            }));
            const lay = baseLayout(xAxisLbl, `PSD (${accelUnit}²/Hz)`, xRange);
            if (freqUnit === 'Hz + CPM') addCpmAxis(lay, xRange);
            return { traces, layout: lay };
        }

        // ── Envelope spectrum ─────────────────────────────────────────────
        if (mode === 'envelope') {
            const conv   = ACCEL_FROM_G[accelUnit] * rms(accelNorm);
            // Prefer the caller-supplied filter range over the global settings range.
            const xRange = xRangeHz
                ? freqRange(xRangeHz[0], xRangeHz[1])
                : freqRange(envelopeFreqMin, envelopeFreqMax);
            const traces = spectrumAxes.map((ax, i) => ({
                x: ax.frequencies.map(toFreqX),
                y: ax.magnitudes.map(v => v * conv),
                type: 'scatter', mode: 'lines',
                name: `Axis ${ax.axisNum}`,
                line: { color: AXIS_COLORS[i % 3], width: 1 },
                hovertemplate: `%{y:.4g} ${accelUnit}<extra>Axis ${ax.axisNum}</extra>`,
            }));
            const yLbl = `Envelope (${accelUnit}${accelNorm === 'rms' ? ' RMS' : ' peak'})`;
            const lay  = baseLayout(xAxisLbl, yLbl, xRange);
            if (freqUnit === 'Hz + CPM') addCpmAxis(lay, xRange);
            return { traces, layout: lay };
        }

        return { traces: [], layout: baseLayout('', '') };
    }, [mode, data, sampleRate, spectrumAxes, settings, xRangeHz]);

    if (traces.length === 0) {
        return (
            <div className="w-full flex-1 min-h-[360px] rounded-xl border border-[#1e293b] bg-slate-950 flex items-center justify-center text-gray-500 text-sm">
                No chart data
            </div>
        );
    }

    return (
        <div className="w-full flex-1 min-h-[360px] rounded-xl border border-[#1e293b] overflow-hidden">
            <Plot
                data={traces}
                layout={layout}
                config={PLOT_CONFIG}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler
            />
        </div>
    );
};

export default WaveformChart;
