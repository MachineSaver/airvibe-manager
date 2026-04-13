'use strict';

const { pool }               = require('../db');
const log                    = require('../logger').child({ module: 'SpectrumProcessor' });
const { deinterleaveWaveform } = require('../utils/deinterleave');
const {
    computeAccelerationSpectrum,
    computeVelocitySpectrum,
    computePSD,
    computeEnvelopeSpectrum,
} = require('../utils/fft');

// Minimum samples required for a meaningful spectrum.
const MIN_SAMPLES = 32;

class SpectrumProcessor {
    /**
     * Compute and persist all four spectrum types for every active axis of a
     * completed waveform.  Written in a single transaction — either all rows
     * commit or none do (ROLLBACK on any failure).
     *
     * Non-blocking: errors are logged and swallowed so a spectrum failure never
     * propagates back into WaveformManager.assembleWaveform().
     *
     * @param {string} waveformId  UUID of the completed waveform row
     */
    async processWaveform(waveformId) {
        try {
            const result = await pool.query(
                `SELECT id, metadata, final_data_bytes, final_data
                 FROM waveforms WHERE id = $1`,
                [waveformId],
            );
            const waveform = result.rows[0];
            if (!waveform) {
                log.warn({ waveformId }, 'SpectrumProcessor: waveform not found');
                return;
            }

            const rawHex = waveform.final_data_bytes
                ? waveform.final_data_bytes.toString('hex')
                : waveform.final_data?.raw_hex;

            if (!rawHex) {
                log.warn({ waveformId }, 'SpectrumProcessor: no waveform data, skipping');
                return;
            }

            const { axisMask, sampleRate, samplesPerAxis } = waveform.metadata;

            const { axis1, axis2, axis3, isAxis1, isAxis2, isAxis3 } =
                deinterleaveWaveform(rawHex, axisMask);

            const axesData = [
                { samples: axis1, active: isAxis1, axisNum: 1 },
                { samples: axis2, active: isAxis2, axisNum: 2 },
                { samples: axis3, active: isAxis3, axisNum: 3 },
            ].filter(a => a.active);

            // Validate sample counts — filter out bad axes rather than aborting all.
            const validAxesData = axesData.filter(({ samples, axisNum }) => {
                if (samples.length < MIN_SAMPLES) {
                    log.warn(
                        { waveformId, axisNum, count: samples.length },
                        'SpectrumProcessor: too few samples, skipping axis',
                    );
                    return false;
                }
                if (samples.length !== samplesPerAxis) {
                    log.warn(
                        { waveformId, axisNum, actual: samples.length, expected: samplesPerAxis },
                        'SpectrumProcessor: sample count mismatch, skipping axis',
                    );
                    return false;
                }
                return true;
            });

            if (validAxesData.length === 0) {
                log.warn({ waveformId }, 'SpectrumProcessor: no valid axes, skipping');
                return;
            }

            // Compute all spectra (CPU work before touching the DB).
            const rows = [];
            for (const { samples, axisNum } of validAxesData) {
                const specs = [
                    { type: 'acceleration', result: computeAccelerationSpectrum(samples, sampleRate) },
                    { type: 'velocity',     result: computeVelocitySpectrum(samples, sampleRate) },
                    { type: 'psd',          result: computePSD(samples, sampleRate) },
                    { type: 'envelope',     result: computeEnvelopeSpectrum(samples, sampleRate, 500, 10000) },
                ];
                for (const { type, result } of specs) {
                    const { frequencies, magnitudes, numBins, freqResHz } = result;
                    rows.push([
                        waveformId,
                        axisNum,
                        type,
                        numBins,
                        freqResHz,
                        _toFloat32Buffer(frequencies),
                        _toFloat32Buffer(magnitudes),
                    ]);
                }
            }

            // Single transaction: all rows commit or all roll back.
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const params of rows) {
                    await client.query(
                        `INSERT INTO waveform_spectra
                             (waveform_id, axis, spectrum_type, num_bins,
                              frequency_resolution_hz, frequencies, magnitudes)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (waveform_id, axis, spectrum_type) DO UPDATE SET
                             frequencies            = EXCLUDED.frequencies,
                             magnitudes             = EXCLUDED.magnitudes,
                             computed_at            = NOW()`,
                        params,
                    );
                }
                await client.query('COMMIT');
                log.info({ waveformId, rows: rows.length }, 'SpectrumProcessor: spectra stored');
            } catch (err) {
                await client.query('ROLLBACK');
                log.error({ err, waveformId }, 'SpectrumProcessor: write failed, rolled back');
            } finally {
                client.release();
            }
        } catch (err) {
            log.error({ err, waveformId }, 'SpectrumProcessor: processWaveform error');
        }
    }

    /**
     * Called at startup to reprocess any complete waveforms that have no
     * spectrum rows (e.g. server crashed between assembleWaveform and
     * processWaveform completing).
     */
    async recoverOrphanedWaveforms() {
        try {
            const result = await pool.query(
                `SELECT w.id
                 FROM waveforms w
                 LEFT JOIN waveform_spectra s ON s.waveform_id = w.id
                 WHERE w.status = 'complete' AND s.id IS NULL`,
            );
            const ids = result.rows.map(r => r.id);
            if (ids.length > 0) {
                log.info({ count: ids.length }, 'SpectrumProcessor: recovering orphaned waveforms');
            }
            for (const id of ids) {
                try {
                    await this.processWaveform(id);
                } catch (err) {
                    log.error({ err, waveformId: id }, 'SpectrumProcessor: recovery failed for waveform');
                }
            }
        } catch (err) {
            log.error({ err }, 'SpectrumProcessor: recoverOrphanedWaveforms error');
        }
    }
}

/**
 * Encode a JS number array as a little-endian float32 Buffer.
 * @param {number[]} arr
 * @returns {Buffer}
 */
function _toFloat32Buffer(arr) {
    const buf = Buffer.allocUnsafe(arr.length * 4);
    for (let i = 0; i < arr.length; i++) {
        buf.writeFloatLE(arr[i], i * 4);
    }
    return buf;
}

module.exports = new SpectrumProcessor();
