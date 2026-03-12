'use strict';

// ---------------------------------------------------------------------------
// Cooley-Tukey radix-2 FFT (in-place, decimation-in-time)
// re, im: Float64Arrays of length N — N must be a power of 2.
// Modifies both arrays in place.
// ---------------------------------------------------------------------------
function _fftInPlace(re, im) {
    const N = re.length;

    // Bit-reversal permutation
    for (let i = 1, j = 0; i < N; i++) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }

    // Butterfly stages
    for (let len = 2; len <= N; len <<= 1) {
        const halfLen = len >> 1;
        const ang = -Math.PI / halfLen; // twiddle factor angle increment
        const wBaseRe = Math.cos(ang);
        const wBaseIm = Math.sin(ang);
        for (let i = 0; i < N; i += len) {
            let wRe = 1, wIm = 0;
            for (let k = 0; k < halfLen; k++) {
                const uRe = re[i + k],          uIm = im[i + k];
                const vRe = re[i + k + halfLen] * wRe - im[i + k + halfLen] * wIm;
                const vIm = re[i + k + halfLen] * wIm + im[i + k + halfLen] * wRe;
                re[i + k]           = uRe + vRe;  im[i + k]           = uIm + vIm;
                re[i + k + halfLen] = uRe - vRe;  im[i + k + halfLen] = uIm - vIm;
                const t = wRe * wBaseRe - wIm * wBaseIm;
                wIm     = wRe * wBaseIm + wIm * wBaseRe;
                wRe     = t;
            }
        }
    }
}

// IFFT via conjugate-FFT-conjugate-normalize.
function _ifftInPlace(re, im) {
    for (let i = 0; i < im.length; i++) im[i] = -im[i];
    _fftInPlace(re, im);
    const N = re.length;
    for (let i = 0; i < N; i++) {
        re[i] /= N;
        im[i] = -im[i] / N;
    }
}

// ---------------------------------------------------------------------------
// Exported utilities
// ---------------------------------------------------------------------------

/**
 * Hann window of length N.
 * w[n] = 0.5 * (1 − cos(2πn / (N−1)))
 * Tapers to exactly 0 at both endpoints.
 * @returns {Float64Array}
 */
function hannWindow(N) {
    const w = new Float64Array(N);
    const denom = N - 1;
    for (let n = 0; n < N; n++) {
        w[n] = 0.5 * (1 - Math.cos(2 * Math.PI * n / denom));
    }
    return w;
}

/**
 * Smallest power of 2 that is >= n.
 * @param {number} n
 * @returns {number}
 */
function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

// ---------------------------------------------------------------------------
// Internal: detrend → window → zero-pad → FFT
// Returns { re, im, M, N, cg, sumW2, freqResHz } ready for spectrum extraction.
// re/im are Float64Arrays of length M (in-place FFT already applied).
// ---------------------------------------------------------------------------
function _preprocessAndFFT(samples, fs) {
    const N = samples.length;
    const M = nextPow2(N);
    const w = hannWindow(N);

    // Compute coherent gain and window power exactly from the window array.
    let sumW = 0, sumW2 = 0;
    for (let i = 0; i < N; i++) {
        sumW  += w[i];
        sumW2 += w[i] * w[i];
    }
    const cg = sumW / N; // coherent gain ≈ 0.5 for Hann

    // Subtract mean (detrend) then apply window.
    let mean = 0;
    for (let i = 0; i < N; i++) mean += samples[i];
    mean /= N;

    // Zero-padded arrays (Float64Array is zero-initialised).
    const re = new Float64Array(M);
    const im = new Float64Array(M);
    for (let i = 0; i < N; i++) re[i] = (samples[i] - mean) * w[i];
    // indices N..M-1 stay 0 (zero-padding)

    _fftInPlace(re, im);

    return { re, im, M, N, cg, sumW2, freqResHz: fs / N };
}

// ---------------------------------------------------------------------------
// One-sided amplitude spectrum helpers
// norm1: DC and Nyquist (no one-sided doubling)
// norm2: interior bins   (one-sided doubling × coherent-gain correction)
// Both divide by 1000 to convert mg → g.
// ---------------------------------------------------------------------------
function _amplitudeFromFFT(re, im, M, N, cg) {
    const numBins = M / 2 + 1;
    const frequencies = new Float64Array(numBins);
    const magnitudes  = new Float64Array(numBins);
    const norm1 = 1 / (N * cg);   // DC / Nyquist
    const norm2 = 2 / (N * cg);   // interior bins

    for (let k = 0; k < numBins; k++) {
        const mag  = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const norm = (k === 0 || k === M / 2) ? norm1 : norm2;
        magnitudes[k]  = (mag * norm) / 1000; // mg → g
        frequencies[k] = 0; // filled below
    }
    return { frequencies, magnitudes, numBins };
}

// ---------------------------------------------------------------------------
// Exported spectrum functions
// All accept: samples {number[]} in milligravity (mg), fs {number} in Hz.
// All return: { frequencies: number[], magnitudes: number[], numBins, freqResHz }
// ---------------------------------------------------------------------------

/**
 * One-sided acceleration amplitude spectrum.
 * Units: g (peak)
 */
function computeAccelerationSpectrum(samples, fs) {
    const { re, im, M, N, cg, freqResHz } = _preprocessAndFFT(samples, fs);
    const numBins    = M / 2 + 1;
    const norm1      = 1 / (N * cg);
    const norm2      = 2 / (N * cg);
    const frequencies = new Array(numBins);
    const magnitudes  = new Array(numBins);

    for (let k = 0; k < numBins; k++) {
        const mag  = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const norm = (k === 0 || k === M / 2) ? norm1 : norm2;
        magnitudes[k]  = (mag * norm) / 1000; // mg → g
        frequencies[k] = k * fs / M;
    }

    return { frequencies, magnitudes, numBins, freqResHz };
}

/**
 * One-sided velocity amplitude spectrum via frequency-domain integration.
 * Units: mm/s (peak)
 *
 * @param {number[]} samples  mg values
 * @param {number}   fs       sample rate Hz
 * @param {number}   hpHz     high-pass cosine-taper cutoff in Hz (default 0.5)
 *                            Bins in [0, hpHz) are zeroed; [hpHz, 2*hpHz) are tapered.
 */
function computeVelocitySpectrum(samples, fs, hpHz = 0.5) {
    const { re, im, M, N, cg, freqResHz } = _preprocessAndFFT(samples, fs);
    const numBins    = M / 2 + 1;
    const norm1      = 1 / (N * cg);
    const norm2      = 2 / (N * cg);
    const frequencies = new Array(numBins);
    const magnitudes  = new Array(numBins);

    for (let k = 0; k < numBins; k++) {
        const f = k * fs / M;
        frequencies[k] = f;

        if (k === 0 || f === 0) {
            magnitudes[k] = 0; // DC: division by zero → set to 0
            continue;
        }

        // Cosine taper high-pass
        let taper = 1;
        if (hpHz > 0) {
            if (f < hpHz) {
                taper = 0;
            } else if (f < 2 * hpHz) {
                taper = 0.5 * (1 - Math.cos(Math.PI * f / hpHz));
            }
        }

        const mag  = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const norm = (k === M / 2) ? norm1 : norm2;
        const A_g  = (mag * norm) / 1000; // mg → g

        // V(f) = A_g [g] * 9.81 [m/s²/g] / (2π*f) [rad/s] * 1000 [mm/m]
        //      = A_g * 9810 / (2π * f)  mm/s
        magnitudes[k] = taper * A_g * 9810 / (2 * Math.PI * f);
    }

    return { frequencies, magnitudes, numBins, freqResHz };
}

/**
 * One-sided Power Spectral Density.
 * Units: g²/Hz
 * Uses exact Σw[n]² (not the 3N/8 approximation).
 */
function computePSD(samples, fs) {
    const { re, im, M, N, sumW2, freqResHz } = _preprocessAndFFT(samples, fs);
    const numBins    = M / 2 + 1;
    const normBase   = fs * sumW2; // PSD denominator
    const frequencies = new Array(numBins);
    const magnitudes  = new Array(numBins);

    for (let k = 0; k < numBins; k++) {
        const power    = re[k] * re[k] + im[k] * im[k];
        const oneSided = (k === 0 || k === M / 2) ? 1 : 2;
        magnitudes[k]  = (oneSided * power / normBase) / 1e6; // mg²/Hz → g²/Hz
        frequencies[k] = k * fs / M;
    }

    return { frequencies, magnitudes, numBins, freqResHz };
}

/**
 * One-sided envelope amplitude spectrum via Hilbert transform.
 * Units: g (peak)
 *
 * Processing chain:
 *   detrend → FFT (no window — Hilbert step)
 *   → bandpass 20–80% Nyquist + Hilbert modification
 *   → IFFT → envelope |z[n]|
 *   → computeAccelerationSpectrum (windows and FFTs the envelope signal)
 */
function computeEnvelopeSpectrum(samples, fs) {
    const N = samples.length;
    const M = nextPow2(N);

    // Detrend only (no Hann window — windowing happens in the final spectrum step)
    let mean = 0;
    for (let i = 0; i < N; i++) mean += samples[i];
    mean /= N;

    const re = new Float64Array(M);
    const im = new Float64Array(M);
    for (let i = 0; i < N; i++) re[i] = samples[i] - mean;

    _fftInPlace(re, im);

    // Bandpass: 20–80% of Nyquist (fs/2)
    const kLo = Math.round(0.2 * M / 2); // 10% of fs → bin index
    const kHi = Math.round(0.8 * M / 2); // 40% of fs → bin index

    // Analytic signal: keep only bandpass positive-frequency bins (doubled),
    // zero everything else (negative freqs, DC, out-of-band).
    const anaRe = new Float64Array(M);
    const anaIm = new Float64Array(M);
    for (let k = kLo; k <= kHi && k < M / 2; k++) {
        anaRe[k] = 2 * re[k];
        anaIm[k] = 2 * im[k];
    }

    _ifftInPlace(anaRe, anaIm);

    // Envelope magnitude for first N samples.
    // Scale by M/N to compensate for zero-padding normalization in IFFT.
    const scale    = M / N;
    const envelope = new Array(N);
    for (let n = 0; n < N; n++) {
        envelope[n] = scale * Math.sqrt(anaRe[n] * anaRe[n] + anaIm[n] * anaIm[n]);
    }

    // Treat envelope values as mg and compute its amplitude spectrum (in g).
    return computeAccelerationSpectrum(envelope, fs);
}

module.exports = {
    hannWindow,
    nextPow2,
    computeAccelerationSpectrum,
    computeVelocitySpectrum,
    computePSD,
    computeEnvelopeSpectrum,
};
