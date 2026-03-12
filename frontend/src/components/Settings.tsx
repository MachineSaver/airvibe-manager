'use client';

import React from 'react';
import {
    useSettings,
    DEFAULT_SETTINGS,
    AccelUnit,
    NormType,
    VelocityUnit,
    FreqUnit,
} from '@/contexts/SettingsContext';

// ── Reusable select ───────────────────────────────────────────────────────────
function SettingSelect<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label:    string;
    value:    T;
    options:  { value: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</label>
            <select
                value={value}
                onChange={e => onChange(e.target.value as T)}
                className="bg-[#1e1e1e] border border-[#3e3e42] text-gray-200 text-xs rounded px-2.5 py-1.5 focus:outline-none focus:border-blue-500 transition-colors hover:border-[#555]"
            >
                {options.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>
        </div>
    );
}

// ── Reusable number input ─────────────────────────────────────────────────────
function FreqInput({
    label,
    value,
    onChange,
}: {
    label:    string;
    value:    number;
    onChange: (v: number) => void;
}) {
    return (
        <div className="flex flex-col gap-1 min-w-[80px]">
            <label className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</label>
            <div className="flex items-center gap-1">
                <input
                    type="number"
                    min={0}
                    value={value}
                    onChange={e => {
                        const n = parseFloat(e.target.value);
                        if (isFinite(n) && n >= 0) onChange(n);
                    }}
                    className="w-full bg-[#1e1e1e] border border-[#3e3e42] text-gray-200 text-xs rounded px-2.5 py-1.5 focus:outline-none focus:border-blue-500 transition-colors hover:border-[#555]"
                />
                <span className="text-[10px] text-gray-500 shrink-0">Hz</span>
            </div>
        </div>
    );
}

// ── Section heading ───────────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
    return (
        <h3 className="text-xs font-semibold text-gray-200 uppercase tracking-wider mb-3 mt-1">
            {children}
        </h3>
    );
}

function SubTitle({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-[11px] font-medium text-blue-400 mb-2">{children}</p>
    );
}

function Card({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-[#252526] border border-[#333] rounded p-4 flex flex-col gap-4">
            {children}
        </div>
    );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Settings() {
    const { settings, updateSettings, resetSettings } = useSettings();

    const ACCEL_UNITS: { value: AccelUnit; label: string }[] = [
        { value: 'g',        label: 'g' },
        { value: 'mg',       label: 'mg' },
        { value: 'm/s²',     label: 'm/s²' },
        { value: 'mm/s²',    label: 'mm/s²' },
        { value: 'inch/s²',  label: 'inch/s²' },
    ];

    const NORM_OPTIONS: { value: NormType; label: string }[] = [
        { value: 'peak', label: 'Peak' },
        { value: 'rms',  label: 'RMS' },
    ];

    const VEL_UNITS: { value: VelocityUnit; label: string }[] = [
        { value: 'mm/s',   label: 'mm/s' },
        { value: 'inch/s', label: 'inch/s' },
    ];

    const FREQ_UNITS: { value: FreqUnit; label: string }[] = [
        { value: 'Hz',        label: 'Hz' },
        { value: 'CPM',       label: 'CPM' },
        { value: 'Hz + CPM',  label: 'Hz + CPM' },
    ];

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] text-gray-300 overflow-y-auto p-6">
            <div className="max-w-2xl w-full mx-auto flex flex-col gap-6">

                {/* Header */}
                <div className="flex items-center justify-between">
                    <h2 className="text-base font-semibold text-white">Display Settings</h2>
                    <button
                        onClick={resetSettings}
                        className="text-xs text-gray-500 hover:text-gray-300 border border-[#3e3e42] hover:border-gray-500 rounded px-3 py-1 transition-colors"
                    >
                        Reset to Defaults
                    </button>
                </div>

                {/* Units and Normalization */}
                <div>
                    <SectionTitle>Units and Normalization</SectionTitle>
                    <div className="flex flex-col gap-3">

                        {/* Acceleration / Envelope */}
                        <Card>
                            <SubTitle>Acceleration / Envelope</SubTitle>
                            <div className="grid grid-cols-2 gap-4">
                                <SettingSelect<AccelUnit>
                                    label="Unit"
                                    value={settings.accelUnit}
                                    options={ACCEL_UNITS}
                                    onChange={v => updateSettings({ accelUnit: v })}
                                />
                                <SettingSelect<NormType>
                                    label="Normalization"
                                    value={settings.accelNorm}
                                    options={NORM_OPTIONS}
                                    onChange={v => updateSettings({ accelNorm: v })}
                                />
                            </div>
                        </Card>

                        {/* Velocity */}
                        <Card>
                            <SubTitle>Velocity</SubTitle>
                            <div className="grid grid-cols-2 gap-4">
                                <SettingSelect<VelocityUnit>
                                    label="Unit"
                                    value={settings.velocityUnit}
                                    options={VEL_UNITS}
                                    onChange={v => updateSettings({ velocityUnit: v })}
                                />
                                <SettingSelect<NormType>
                                    label="Normalization"
                                    value={settings.velocityNorm}
                                    options={NORM_OPTIONS}
                                    onChange={v => updateSettings({ velocityNorm: v })}
                                />
                            </div>
                        </Card>

                        {/* Spectrum Frequency */}
                        <Card>
                            <SubTitle>Spectrum Frequency Axis</SubTitle>
                            <SettingSelect<FreqUnit>
                                label="Unit"
                                value={settings.freqUnit}
                                options={FREQ_UNITS}
                                onChange={v => updateSettings({ freqUnit: v })}
                            />
                            {settings.freqUnit === 'Hz + CPM' && (
                                <p className="text-[10px] text-gray-500 italic -mt-1">
                                    CPM axis displayed on top of chart. Zoom resets CPM range to match.
                                </p>
                            )}
                        </Card>
                    </div>
                </div>

                {/* Frequency Ranges */}
                <div>
                    <SectionTitle>Default Frequency Display Ranges</SectionTitle>
                    <p className="text-[11px] text-gray-500 mb-3 -mt-1">
                        Sets the initial X-axis zoom range on spectrum charts. Drag to zoom or double-click to reset.
                    </p>
                    <div className="flex flex-col gap-3">

                        <Card>
                            <SubTitle>Velocity Spectrum</SubTitle>
                            <div className="grid grid-cols-2 gap-4">
                                <FreqInput
                                    label="Min"
                                    value={settings.velocityFreqMin}
                                    onChange={v => updateSettings({ velocityFreqMin: v })}
                                />
                                <FreqInput
                                    label="Max"
                                    value={settings.velocityFreqMax}
                                    onChange={v => updateSettings({ velocityFreqMax: v })}
                                />
                            </div>
                        </Card>

                        <Card>
                            <SubTitle>Acceleration Spectrum</SubTitle>
                            <div className="grid grid-cols-2 gap-4">
                                <FreqInput
                                    label="Min"
                                    value={settings.accelFreqMin}
                                    onChange={v => updateSettings({ accelFreqMin: v })}
                                />
                                <FreqInput
                                    label="Max"
                                    value={settings.accelFreqMax}
                                    onChange={v => updateSettings({ accelFreqMax: v })}
                                />
                            </div>
                        </Card>

                        <Card>
                            <SubTitle>Envelope Spectrum</SubTitle>
                            <div className="grid grid-cols-2 gap-4">
                                <FreqInput
                                    label="Min"
                                    value={settings.envelopeFreqMin}
                                    onChange={v => updateSettings({ envelopeFreqMin: v })}
                                />
                                <FreqInput
                                    label="Max"
                                    value={settings.envelopeFreqMax}
                                    onChange={v => updateSettings({ envelopeFreqMax: v })}
                                />
                            </div>
                        </Card>

                    </div>
                </div>

                {/* Current values preview */}
                <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-3">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Active Configuration</p>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[10px] font-mono">
                        <span className="text-gray-500">Accel/Envelope unit</span>
                        <span className="text-gray-300">{settings.accelUnit} ({settings.accelNorm})</span>
                        <span className="text-gray-500">Velocity unit</span>
                        <span className="text-gray-300">{settings.velocityUnit} ({settings.velocityNorm})</span>
                        <span className="text-gray-500">Frequency axis</span>
                        <span className="text-gray-300">{settings.freqUnit}</span>
                        <span className="text-gray-500">Velocity range</span>
                        <span className="text-gray-300">{settings.velocityFreqMin} – {settings.velocityFreqMax} Hz</span>
                        <span className="text-gray-500">Accel range</span>
                        <span className="text-gray-300">{settings.accelFreqMin} – {settings.accelFreqMax} Hz</span>
                        <span className="text-gray-500">Envelope range</span>
                        <span className="text-gray-300">{settings.envelopeFreqMin} – {settings.envelopeFreqMax} Hz</span>
                    </div>
                    <p className="text-[9px] text-gray-600 mt-2">Settings are saved automatically in your browser.</p>
                </div>

                {/* Default values reference */}
                <div className="text-[10px] text-gray-600 pb-4">
                    Defaults: {DEFAULT_SETTINGS.accelUnit} peak · {DEFAULT_SETTINGS.velocityUnit} peak · {DEFAULT_SETTINGS.freqUnit} ·
                    Vel {DEFAULT_SETTINGS.velocityFreqMin}–{DEFAULT_SETTINGS.velocityFreqMax} Hz ·
                    Accel {DEFAULT_SETTINGS.accelFreqMin}–{DEFAULT_SETTINGS.accelFreqMax} Hz ·
                    Env {DEFAULT_SETTINGS.envelopeFreqMin}–{DEFAULT_SETTINGS.envelopeFreqMax} Hz
                </div>
            </div>
        </div>
    );
}
