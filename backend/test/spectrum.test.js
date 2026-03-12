'use strict';

// ---------------------------------------------------------------------------
// Mock external dependencies before any require() calls.
// ---------------------------------------------------------------------------

jest.mock('../src/db', () => ({
    pool: {
        query: jest.fn(),
        connect: jest.fn(),
    },
}));

const { pool } = require('../src/db');

// These modules do not exist yet — the suite will fail with "Cannot find module"
// which is the expected RED state for TDD.
const {
    hannWindow,
    nextPow2,
    computeAccelerationSpectrum,
    computeVelocitySpectrum,
    computePSD,
    computeEnvelopeSpectrum,
} = require('../src/utils/fft');

const spectrumProcessor = require('../src/services/SpectrumProcessor');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an int16 LE Buffer representing a pure cosine at bin k0.
 * x[n] = amplitudeMg * cos(2π * k0 * n / N)
 */
function makeSineBuffer(N, k0, amplitudeMg) {
    const buf = Buffer.allocUnsafe(N * 2);
    for (let n = 0; n < N; n++) {
        const v = Math.round(amplitudeMg * Math.cos(2 * Math.PI * k0 * n / N));
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), n * 2);
    }
    return buf;
}

/** Convert a single-axis int16 LE Buffer to a plain number array (millig). */
function bufToSamples(buf) {
    const out = [];
    for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
    return out;
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// hannWindow
// ---------------------------------------------------------------------------

describe('hannWindow', () => {
    it('returns zeros at both endpoints', () => {
        const w = hannWindow(64);
        expect(w[0]).toBeCloseTo(0, 5);
        expect(w[63]).toBeCloseTo(0, 5);
    });

    it('peaks near the centre with a value close to 1', () => {
        const N = 64;
        const w = hannWindow(N);
        expect(w[Math.floor(N / 2)]).toBeGreaterThan(0.99);
    });

    it('is symmetric', () => {
        const N = 128;
        const w = hannWindow(N);
        for (let i = 0; i < N / 2; i++) {
            expect(w[i]).toBeCloseTo(w[N - 1 - i], 10);
        }
    });

    it('returns an array of length N', () => {
        expect(hannWindow(32).length).toBe(32);
        expect(hannWindow(256).length).toBe(256);
    });
});

// ---------------------------------------------------------------------------
// nextPow2
// ---------------------------------------------------------------------------

describe('nextPow2', () => {
    it('returns N itself when N is already a power of 2', () => {
        expect(nextPow2(1)).toBe(1);
        expect(nextPow2(64)).toBe(64);
        expect(nextPow2(256)).toBe(256);
        expect(nextPow2(1024)).toBe(1024);
    });

    it('rounds up to the next power of 2 for non-power-of-2 inputs', () => {
        expect(nextPow2(65)).toBe(128);
        expect(nextPow2(100)).toBe(128);
        expect(nextPow2(500)).toBe(512);
        expect(nextPow2(600)).toBe(1024);
        expect(nextPow2(257)).toBe(512);
    });
});

// ---------------------------------------------------------------------------
// computeAccelerationSpectrum
// ---------------------------------------------------------------------------

describe('computeAccelerationSpectrum', () => {
    it('recovers the amplitude of a pure sinusoid in g within 5% (4/N Hann correction)', () => {
        // N=256 (power of 2, no padding needed), k0=8, A=1000 mg = 1 g, fs=1024 Hz
        const N = 256, k0 = 8, A_mg = 1000, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, k0, A_mg));

        const { frequencies, magnitudes } = computeAccelerationSpectrum(samples, fs);

        // f0 = 8 * 1024/256 = 32 Hz
        const f0 = k0 * fs / N;
        const binIdx = frequencies.findIndex(f => Math.abs(f - f0) < fs / N / 2);
        expect(binIdx).toBeGreaterThanOrEqual(0);

        // Should recover ≈ 1.0 g (not 0.5 g which the wrong 2/N factor would give)
        expect(magnitudes[binIdx]).toBeGreaterThan(0.95);
        expect(magnitudes[binIdx]).toBeLessThan(1.05);
    });

    it('returns a one-sided spectrum with N/2+1 bins for a power-of-2 input', () => {
        const N = 128, fs = 1000;
        const { frequencies, magnitudes } = computeAccelerationSpectrum(Array(N).fill(0), fs);
        expect(frequencies.length).toBe(N / 2 + 1);
        expect(magnitudes.length).toBe(N / 2 + 1);
    });

    it('stores freqResHz as fs/N_original, not fs/N_padded', () => {
        // N=100 is not a power of 2 — will be zero-padded to 128 internally.
        // True frequency resolution is fs/100 = 10 Hz, not fs/128 = 7.8 Hz.
        const N = 100, fs = 1000;
        const { freqResHz } = computeAccelerationSpectrum(Array(N).fill(0), fs);
        expect(freqResHz).toBeCloseTo(fs / N, 4); // 10.0 Hz
    });

    it('has all non-negative magnitudes', () => {
        const N = 64, fs = 512;
        const samples = bufToSamples(makeSineBuffer(N, 3, 500));
        const { magnitudes } = computeAccelerationSpectrum(samples, fs);
        magnitudes.forEach(m => expect(m).toBeGreaterThanOrEqual(0));
    });

    it('outputs amplitude in g, not mg (divides by 1000)', () => {
        // 1000 mg = 1 g — peak should be near 1, not near 1000
        const N = 256, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, 8, 1000));
        const { magnitudes } = computeAccelerationSpectrum(samples, fs);
        const peak = Math.max(...magnitudes);
        expect(peak).toBeLessThan(10); // definitely not 1000
        expect(peak).toBeGreaterThan(0.5);
    });
});

// ---------------------------------------------------------------------------
// computeVelocitySpectrum
// ---------------------------------------------------------------------------

describe('computeVelocitySpectrum', () => {
    it('converts acceleration to velocity via V(f) = A_g * 9810 / (2π*f) mm/s', () => {
        // 1000 mg = 1 g at 32 Hz → V ≈ 9810 / (2π*32) ≈ 48.8 mm/s
        const N = 256, k0 = 8, A_mg = 1000, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, k0, A_mg));

        const { frequencies, magnitudes } = computeVelocitySpectrum(samples, fs);

        const f0 = k0 * fs / N; // 32 Hz
        const binIdx = frequencies.findIndex(f => Math.abs(f - f0) < fs / N / 2);
        expect(binIdx).toBeGreaterThanOrEqual(0);

        const expectedMmPerSec = (A_mg * 9.81) / (2 * Math.PI * f0); // ≈ 48.8
        expect(magnitudes[binIdx]).toBeGreaterThan(expectedMmPerSec * 0.90);
        expect(magnitudes[binIdx]).toBeLessThan(expectedMmPerSec * 1.10);
    });

    it('sets the DC bin (f=0) to zero to prevent division-by-zero drift', () => {
        const N = 256, fs = 1024;
        const { magnitudes } = computeVelocitySpectrum(Array(N).fill(1000), fs);
        expect(magnitudes[0]).toBe(0);
    });

    it('applies a cosine taper so bins inside the taper zone are attenuated', () => {
        // N=256, fs=1024 → bin spacing Δf = 4 Hz/bin.
        // bin 1 = 4 Hz. Use hpHz=3 so taper zone is [3, 6] Hz — bin 1 is inside it.
        // Expected taper at 4 Hz: 0.5*(1 − cos(π*4/3)) = 0.75 → filtered < unfiltered.
        const N = 256, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, 1, 1000)); // k=1 → 4 Hz
        const { magnitudes: filtered } = computeVelocitySpectrum(samples, fs, 3);
        const { magnitudes: noFilter } = computeVelocitySpectrum(samples, fs, 0);
        expect(filtered[1]).toBeLessThan(noFilter[1]);
    });

    it('does not attenuate bins well above the high-pass cutoff', () => {
        // k0=8 → f=32 Hz, far above the 0.5 Hz default cutoff
        const N = 256, k0 = 8, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, k0, 1000));
        const { magnitudes: filtered } = computeVelocitySpectrum(samples, fs, 0.5);
        const { magnitudes: noFilter } = computeVelocitySpectrum(samples, fs, 0);
        expect(filtered[k0]).toBeCloseTo(noFilter[k0], 3);
    });

    it('has all non-negative magnitudes', () => {
        const N = 64, fs = 512;
        const samples = bufToSamples(makeSineBuffer(N, 4, 500));
        const { magnitudes } = computeVelocitySpectrum(samples, fs);
        magnitudes.forEach(m => expect(m).toBeGreaterThanOrEqual(0));
    });
});

// ---------------------------------------------------------------------------
// computePSD
// ---------------------------------------------------------------------------

describe('computePSD', () => {
    it('has its peak at the signal frequency bin', () => {
        const N = 256, k0 = 8, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, k0, 1000));
        const { frequencies, magnitudes } = computePSD(samples, fs);

        const f0 = k0 * fs / N;
        const peakBin = magnitudes.indexOf(Math.max(...magnitudes));
        expect(Math.abs(frequencies[peakBin] - f0)).toBeLessThan(fs / N);
    });

    it('has all non-negative magnitudes', () => {
        const N = 128, fs = 1000;
        const samples = bufToSamples(makeSineBuffer(N, 5, 300));
        const { magnitudes } = computePSD(samples, fs);
        magnitudes.forEach(m => expect(m).toBeGreaterThanOrEqual(0));
    });

    it('stores freqResHz as fs/N_original for non-power-of-2 inputs', () => {
        const N = 100, fs = 1000; // padded to 128 internally
        const { freqResHz } = computePSD(Array(N).fill(0), fs);
        expect(freqResHz).toBeCloseTo(fs / N, 4); // 10 Hz, not 7.8 Hz
    });

    it('outputs units in g²/Hz (magnitudes are much less than 1 for a 1 g sinusoid)', () => {
        // For a 1 g sinusoid at 32 Hz with 256 samples at 1024 Hz:
        // PSD peak ≈ A² / (2 * ENBW) where ENBW ≈ 1.5 * 4 Hz = 6 Hz
        // ≈ 1² / (2 * 6) ≈ 0.083 g²/Hz — far less than 1 g
        const N = 256, k0 = 8, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, k0, 1000)); // 1000 mg = 1 g
        const { magnitudes } = computePSD(samples, fs);
        const peak = Math.max(...magnitudes);
        expect(peak).toBeGreaterThan(0);
        expect(peak).toBeLessThan(1); // definitely not in mg² scale (would be 1e6)
    });
});

// ---------------------------------------------------------------------------
// computeEnvelopeSpectrum
// ---------------------------------------------------------------------------

describe('computeEnvelopeSpectrum', () => {
    it('reveals the modulation frequency for an AM-modulated carrier in the pass band', () => {
        // AM signal: x[n] = A*(1 + cos(2π*k_mod*n/N)) * cos(2π*k_c*n/N)
        // Carrier k_c=32 → f_c=128 Hz. Pass explicit hpHz=50, lpHz=400 so the
        // carrier is inside the bandpass for this test's fs=1024 Hz signal.
        // Modulation k_mod=2 → f_mod=8 Hz.
        // After Hilbert envelope and detrend: residual ≈ A*cos(2π*f_mod*t).
        // The envelope spectrum peak should be near bin k_mod=2 (8 Hz).
        const N = 256, k_c = 32, k_mod = 2, A_mg = 1000, fs = 1024;
        const samples = [];
        for (let n = 0; n < N; n++) {
            const v = A_mg
                * (1 + Math.cos(2 * Math.PI * k_mod * n / N))
                * Math.cos(2 * Math.PI * k_c * n / N);
            samples.push(Math.max(-32768, Math.min(32767, Math.round(v))));
        }

        // hpHz=50 Hz, lpHz=400 Hz: carrier at 128 Hz is within the passband
        const { frequencies, magnitudes } = computeEnvelopeSpectrum(samples, fs, 50, 400);

        // The largest peak should be near f_mod = 8 Hz (within ±1 bin)
        const peakBin = magnitudes.indexOf(Math.max(...magnitudes));
        const f_mod   = k_mod * fs / N; // 8 Hz
        expect(Math.abs(frequencies[peakBin] - f_mod)).toBeLessThan(fs / N * 2);
    });

    it('has all non-negative magnitudes', () => {
        const N = 128, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, 16, 800)); // 128 Hz carrier
        // Use an explicit bandpass that includes the 128 Hz carrier
        const { magnitudes } = computeEnvelopeSpectrum(samples, fs, 50, 400);
        magnitudes.forEach(m => expect(m).toBeGreaterThanOrEqual(0));
    });

    it('returns a one-sided spectrum with the same frequency axis shape as acceleration', () => {
        const N = 256, fs = 1024;
        const samples = bufToSamples(makeSineBuffer(N, 32, 500));
        const { frequencies: fAccel } = computeAccelerationSpectrum(samples, fs);
        const { frequencies: fEnv } = computeEnvelopeSpectrum(samples, fs, 50, 400);
        expect(fEnv.length).toBe(fAccel.length);
        expect(fEnv[1]).toBeCloseTo(fAccel[1], 5);
    });

    it('respects explicit hpHz/lpHz — carrier below HP produces much less output than carrier in band', () => {
        // Carrier k_c=32 → f_c=128 Hz (fs=1024, N=256)
        const N = 256, k_c = 32, fs = 1024, A_mg = 1000;
        const samples = bufToSamples(makeSineBuffer(N, k_c, A_mg));

        // Passband that INCLUDES the carrier (50–200 Hz)
        const { magnitudes: magIn } = computeEnvelopeSpectrum(samples, fs, 50, 200);
        // Passband that EXCLUDES the carrier (200–400 Hz — carrier at 128 Hz is below HP)
        const { magnitudes: magOut } = computeEnvelopeSpectrum(samples, fs, 200, 400);

        const sumIn  = magIn.reduce((a, b) => a + b, 0);
        const sumOut = magOut.reduce((a, b) => a + b, 0);
        // In-band should produce significantly more total energy
        expect(sumIn).toBeGreaterThan(sumOut * 5);
    });
});

// ---------------------------------------------------------------------------
// SpectrumProcessor — processWaveform
// ---------------------------------------------------------------------------

describe('SpectrumProcessor — processWaveform', () => {
    /** Build a mock waveform DB row. */
    function makeWaveformRow({ N = 64, axisMask = 0x01, sampleRate = 1024, finalDataBytes } = {}) {
        const buf = finalDataBytes ?? makeSineBuffer(N, 4, 500);
        return {
            id: 'waveform-uuid-1',
            metadata: { sampleRate, samplesPerAxis: N, axisMask },
            final_data_bytes: buf,
            final_data: null,
            status: 'complete',
        };
    }

    let mockClient;

    beforeEach(() => {
        mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        };
        pool.connect.mockResolvedValue(mockClient);
        pool.query.mockResolvedValue({ rows: [] });
    });

    it('skips DB writes when samplesPerAxis < 32', async () => {
        pool.query.mockResolvedValueOnce({ rows: [makeWaveformRow({ N: 16 })] });

        await spectrumProcessor.processWaveform('waveform-uuid-1');

        expect(pool.connect).not.toHaveBeenCalled();
    });

    it('skips DB writes when actual sample count mismatches metadata.samplesPerAxis', async () => {
        // Metadata says 64 samples but buffer only contains 32 samples of data
        const shortBuf = makeSineBuffer(32, 4, 500);
        pool.query.mockResolvedValueOnce({ rows: [makeWaveformRow({ N: 64, finalDataBytes: shortBuf })] });

        await spectrumProcessor.processWaveform('waveform-uuid-1');

        expect(pool.connect).not.toHaveBeenCalled();
    });

    it('writes exactly 4 spectra in a transaction for a single-axis waveform', async () => {
        pool.query.mockResolvedValueOnce({ rows: [makeWaveformRow({ N: 64, axisMask: 0x01 })] });

        await spectrumProcessor.processWaveform('waveform-uuid-1');

        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');

        const inserts = mockClient.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO waveform_spectra'),
        );
        expect(inserts).toHaveLength(4);

        // Each of the four required spectrum types must be present
        const types = inserts.map(c => c[1][2]); // params: [waveformId, axis, type, ...]
        expect(types).toContain('acceleration');
        expect(types).toContain('velocity');
        expect(types).toContain('psd');
        expect(types).toContain('envelope');

        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(mockClient.release).toHaveBeenCalled();
    });

    it('writes exactly 12 spectra in a transaction for a tri-axis waveform', async () => {
        const N = 64;
        // Tri-axis interleaved: [a1_s0, a2_s0, a3_s0, a1_s1, ...] — 6 bytes per sample set
        const triBuf = Buffer.allocUnsafe(N * 6);
        for (let n = 0; n < N; n++) {
            const v = Math.max(-32768, Math.min(32767, Math.round(500 * Math.cos(2 * Math.PI * 4 * n / N))));
            triBuf.writeInt16LE(v, n * 6);
            triBuf.writeInt16LE(v, n * 6 + 2);
            triBuf.writeInt16LE(v, n * 6 + 4);
        }
        pool.query.mockResolvedValueOnce({ rows: [makeWaveformRow({ N, axisMask: 0x07, finalDataBytes: triBuf })] });

        await spectrumProcessor.processWaveform('waveform-uuid-1');

        const inserts = mockClient.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO waveform_spectra'),
        );
        expect(inserts).toHaveLength(12); // 4 spectrum types × 3 axes
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('issues a ROLLBACK and releases the client if a write fails', async () => {
        pool.query.mockResolvedValueOnce({ rows: [makeWaveformRow({ N: 64, axisMask: 0x01 })] });
        mockClient.query
            .mockResolvedValueOnce({ rows: [] }) // BEGIN succeeds
            .mockRejectedValueOnce(new Error('simulated write failure'));

        await spectrumProcessor.processWaveform('waveform-uuid-1');

        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalled();
    });

    it('stores frequencies and magnitudes as float32 LE Buffers (4 bytes per value)', async () => {
        pool.query.mockResolvedValueOnce({ rows: [makeWaveformRow({ N: 64, axisMask: 0x01 })] });

        await spectrumProcessor.processWaveform('waveform-uuid-1');

        const inserts = mockClient.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0].includes('INSERT INTO waveform_spectra'),
        );
        for (const insert of inserts) {
            const bufferParams = insert[1].filter(p => Buffer.isBuffer(p));
            expect(bufferParams).toHaveLength(2); // frequencies + magnitudes
            bufferParams.forEach(buf => {
                expect(buf.length).toBeGreaterThan(0);
                expect(buf.length % 4).toBe(0); // float32 = 4 bytes per element
            });
        }
    });
});

// ---------------------------------------------------------------------------
// SpectrumProcessor — recoverOrphanedWaveforms
// ---------------------------------------------------------------------------

describe('SpectrumProcessor — recoverOrphanedWaveforms', () => {
    it('queries for complete waveforms that have no rows in waveform_spectra', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        await spectrumProcessor.recoverOrphanedWaveforms();

        const sql = pool.query.mock.calls[0][0];
        expect(sql).toMatch(/LEFT JOIN waveform_spectra/i);
        expect(sql).toMatch(/status\s*=\s*'complete'/i);
        expect(sql).toMatch(/s\.id IS NULL/i);
    });

    it('calls processWaveform once for each orphaned waveform', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 'orphan-uuid-1' }, { id: 'orphan-uuid-2' }],
        });

        const spy = jest.spyOn(spectrumProcessor, 'processWaveform').mockResolvedValue(undefined);

        await spectrumProcessor.recoverOrphanedWaveforms();

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenCalledWith('orphan-uuid-1');
        expect(spy).toHaveBeenCalledWith('orphan-uuid-2');

        spy.mockRestore();
    });

    it('continues processing remaining orphans if one fails', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 'fail-uuid' }, { id: 'ok-uuid' }],
        });

        const spy = jest.spyOn(spectrumProcessor, 'processWaveform')
            .mockRejectedValueOnce(new Error('processing error'))
            .mockResolvedValueOnce(undefined);

        await spectrumProcessor.recoverOrphanedWaveforms();

        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
    });
});
