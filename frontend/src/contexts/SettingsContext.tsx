'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

export type AccelUnit     = 'g' | 'mg' | 'm/s²' | 'mm/s²' | 'inch/s²';
export type NormType      = 'peak' | 'rms';
export type VelocityUnit  = 'mm/s' | 'inch/s';
export type FreqUnit      = 'Hz' | 'CPM' | 'Hz + CPM';

export interface ChartSettings {
    // Units and normalization
    accelUnit:     AccelUnit;
    accelNorm:     NormType;
    velocityUnit:  VelocityUnit;
    velocityNorm:  NormType;
    freqUnit:      FreqUnit;
    // Chart display frequency ranges (Hz) per spectrum type
    velocityFreqMin:  number;
    velocityFreqMax:  number;
    accelFreqMin:     number;
    accelFreqMax:     number;
    envelopeFreqMin:  number;
    envelopeFreqMax:  number;
}

export const DEFAULT_SETTINGS: ChartSettings = {
    accelUnit:        'g',
    accelNorm:        'peak',
    velocityUnit:     'mm/s',
    velocityNorm:     'peak',
    freqUnit:         'Hz',
    velocityFreqMin:  2,
    velocityFreqMax:  1000,
    accelFreqMin:     2,
    accelFreqMax:     6500,
    envelopeFreqMin:  2,
    envelopeFreqMax:  1500,
};

interface SettingsContextValue {
    settings:       ChartSettings;
    updateSettings: (patch: Partial<ChartSettings>) => void;
    resetSettings:  () => void;
}

const SettingsContext = createContext<SettingsContextValue>({
    settings:       DEFAULT_SETTINGS,
    updateSettings: () => {},
    resetSettings:  () => {},
});

const STORAGE_KEY = 'airvibe_chart_settings';

export function SettingsProvider({ children }: { children: React.ReactNode }) {
    // Lazy initializer: runs only on client — localStorage not available during SSR.
    const [settings, setSettings] = useState<ChartSettings>(() => {
        if (typeof window === 'undefined') return DEFAULT_SETTINGS;
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
        } catch { /* ignore corrupt data */ }
        return DEFAULT_SETTINGS;
    });

    // Persist whenever settings change.
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch { /* ignore */ }
    }, [settings]);

    const updateSettings = (patch: Partial<ChartSettings>) =>
        setSettings(prev => ({ ...prev, ...patch }));

    const resetSettings = () => setSettings(DEFAULT_SETTINGS);

    return (
        <SettingsContext.Provider value={{ settings, updateSettings, resetSettings }}>
            {children}
        </SettingsContext.Provider>
    );
}

export function useSettings() {
    return useContext(SettingsContext);
}

export { SettingsContext };
