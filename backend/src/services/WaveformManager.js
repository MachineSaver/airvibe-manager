const { pool } = require('../db');
const codec = require('../codec/AirVibe_TS013_Codec');
const auditLogger = require('./AuditLogger');
const log = require('../logger').child({ module: 'WaveformManager' });
const spectrumProcessor = require('./SpectrumProcessor');

class WaveformManager {
    constructor() {
        this.startCleanupJob();
        this.startTWIUCheckJob();
        this.lastDownlinkTimes = new Map();
        this.repairTimeouts = new Map(); // waveformId → timeout handle
    }

    async processPacket(topic, message) {
        try {
            let buffer;

            // Try to parse as JSON (Actility format)
            try {
                const json = JSON.parse(message.toString());
                if (json.DevEUI_uplink && json.DevEUI_uplink.payload_hex) {
                    buffer = Buffer.from(json.DevEUI_uplink.payload_hex, 'hex');
                }
            } catch (e) {
                // Not JSON, treat as raw buffer
            }

            // Fallback to raw message if not parsed from JSON
            if (!buffer) {
                buffer = message;
            }

            const payloadHex = buffer.toString('hex');
            // Basic validation
            if (!/^[0-9a-fA-F]+$/.test(payloadHex)) return;
            const type = buffer[0];
            const txId = buffer[1];

            // Extract DevEUI from topic (assuming mqtt/things/DEVEUI/uplink)
            const parts = topic.split('/');
            const devEui = parts[2];

            if (!devEui) return;

            if (type === 0x03) {
                await this.handleTWIU(devEui, txId, buffer);
            } else if (type === 0x01) {
                await this.handleDataSegment(devEui, txId, buffer, false);
            } else if (type === 0x05) {
                await this.handleDataSegment(devEui, txId, buffer, true);
            }
        } catch (err) {
            log.error({ err }, 'Error processing packet');
        }
    }

    async abortStalePendingWaveforms(devEui, newTxId) {
        const res = await pool.query(
            `SELECT id, transaction_id FROM waveforms WHERE device_eui = $1 AND status = 'pending'`,
            [devEui]
        );
        for (const row of res.rows) {
            const distance = (newTxId - row.transaction_id + 256) % 256;
            // distance 1-128 means newTxId is ahead → abort the old one
            // distance 0 is same TxID (handled separately), 129-255 means stale retransmit
            if (distance >= 1 && distance <= 128) {
                await pool.query(`UPDATE waveforms SET status = 'aborted' WHERE id = $1`, [row.id]);
                log.info(`Aborted stale waveform ${row.id} (TxID ${row.transaction_id}) for ${devEui}, superseded by TxID ${newTxId}`);
            }
        }
    }

    async handleTWIU(devEui, txId, buffer) {
        // Abort any pending waveforms with older transaction IDs
        await this.abortStalePendingWaveforms(devEui, txId);

        // Use canonical codec to parse TWIU packet
        const { data } = codec.decodeUplink({ bytes: [...buffer], fPort: 8 });

        const metadata = {
            sampleRate: data.sampling_rate_hz,
            samplesPerAxis: data.samples_per_axis,
            axisSelection: data.axis_selection,
            axisMask: buffer[4],
            numSegments: data.number_of_segments,
            hwFilter: data.hw_filter,
            errorCode: data.error_code,
        };

        const numSegments = data.number_of_segments;

        // Find existing pending waveform or create new
        let waveformId = await this.findPendingWaveformId(devEui, txId);

        if (waveformId) {
            // If this waveform already has metadata, it could be a TxID rollover (256 transactions
            // have elapsed and the counter wrapped) OR a simple TWIU retransmission (device did not
            // receive our ACK and is resending). Distinguish the two by age:
            //   - Age < 255 min → retransmission: update metadata in place, preserve earliest created_at
            //   - Age ≥ 255 min → genuine rollover: abort old row and start fresh
            // 255 min is the minimum physical rollover period (255 transactions × ≥1 min apart).
            const existing = await pool.query(`SELECT metadata, created_at FROM waveforms WHERE id = $1`, [waveformId]);
            const row = existing.rows[0];
            if (row?.metadata) {
                const ageMinutes = (Date.now() - new Date(row.created_at).getTime()) / 60000;
                if (ageMinutes >= 255) {
                    await pool.query(`UPDATE waveforms SET status = 'aborted' WHERE id = $1`, [waveformId]);
                    log.info(`Aborted rolled-over TxID ${txId} waveform ${waveformId} for ${devEui} (age: ${Math.round(ageMinutes)} min)`);
                    waveformId = null;
                } else {
                    log.info(`Duplicate TWIU for ${devEui} TxID ${txId} (age: ${Math.round(ageMinutes)} min) — updating metadata in place`);
                    // waveformId stays set; falls through to the UPDATE block below
                }
            }
        }

        if (waveformId) {
            await pool.query(`
                UPDATE waveforms SET metadata = $1, expected_segments = $2, last_updated = NOW()
                WHERE id = $3
            `, [metadata, numSegments, waveformId]);
        } else {
            const res = await pool.query(`
                INSERT INTO waveforms (device_eui, transaction_id, expected_segments, metadata, status)
                VALUES ($1, $2, $3, $4, 'pending')
                RETURNING id
            `, [devEui, txId, numSegments, metadata]);
            waveformId = res.rows[0].id;
        }

        log.info(`TWIU received for ${devEui} TxID ${txId}`);

        // Send ACK via codec (rate-limited — Class A can only receive one downlink per uplink)
        const ackResult = codec.encodeDownlink({
            fPort: 20,
            data: { opcode: 'waveform_info_ack', transaction_id: txId }
        });
        this.sendAutoDownlink(devEui, 20, Buffer.from(ackResult.bytes));
        auditLogger.log('waveform_manager', 'twiu_ack', devEui, { fPort: 20, txId });
    }

    async handleDataSegment(devEui, txId, buffer, isLast) {
        // Abort any pending waveforms with older transaction IDs
        await this.abortStalePendingWaveforms(devEui, txId);

        // Use canonical codec to parse data segment
        const { data } = codec.decodeUplink({ bytes: [...buffer], fPort: 8 });
        const segmentIndex = data.segment_number;
        const payload = buffer.subarray(4); // Raw sample data starts at byte 4

        // Find or Create Waveform (if out of order)
        let waveformId = await this.findPendingWaveformId(devEui, txId);
        if (!waveformId) {
            // Create placeholder without metadata
            const res = await pool.query(`
                INSERT INTO waveforms (device_eui, transaction_id, status)
                VALUES ($1, $2, 'pending')
                RETURNING id
            `, [devEui, txId]);
            waveformId = res.rows[0].id;
        }

        // Insert Segment
        const insertResult = await pool.query(`
            INSERT INTO waveform_segments (waveform_id, segment_index, data)
            VALUES ($1, $2, $3)
            ON CONFLICT (waveform_id, segment_index) DO NOTHING
            RETURNING segment_index
        `, [waveformId, segmentIndex, payload]);

        // Update last_updated and increment segment count if this was a new segment
        if (insertResult.rowCount > 0) {
            await pool.query(`
                UPDATE waveforms
                SET last_updated = NOW(),
                    received_segments_count = received_segments_count + 1
                WHERE id = $1
            `, [waveformId]);
        } else {
            // Just update timestamp for duplicate segment
            await pool.query(`UPDATE waveforms SET last_updated = NOW() WHERE id = $1`, [waveformId]);
        }

        if (isLast) {
            await this.checkCompletion(devEui, txId, waveformId);
        } else if (insertResult.rowCount > 0) {
            // Not the final segment — but if we're mid-repair, check whether
            // the outstanding requested batch has now been fully received so
            // we can issue the next batch request.
            await this.checkRepairBatchComplete(devEui, txId, waveformId);
        }
    }

    async checkCompletion(devEui, txId, waveformId) {
        // Get waveform info
        const wfRes = await pool.query(`SELECT expected_segments, metadata FROM waveforms WHERE id = $1`, [waveformId]);
        const wf = wfRes.rows[0];

        if (!wf.metadata) {
            // Missing TWIU, can't check completion yet.
            return;
        }

        const expected = wf.expected_segments;

        // Get all segment indices
        const segRes = await pool.query(`SELECT segment_index FROM waveform_segments WHERE waveform_id = $1`, [waveformId]);
        const receivedIndices = new Set(segRes.rows.map(r => r.segment_index));

        const missing = [];
        for (let i = 0; i < expected; i++) {
            if (!receivedIndices.has(i)) missing.push(i);
        }

        if (missing.length === 0) {
            // Complete!
            await this.assembleWaveform(waveformId);
            log.info(`Waveform ${devEui} TxID ${txId} Complete!`);

            // Send Data ACK via codec (rate-limited — Class A can only receive one downlink per uplink)
            const ackResult = codec.encodeDownlink({
                fPort: 20,
                data: { opcode: 'waveform_data_ack', transaction_id: txId }
            });
            this.sendAutoDownlink(devEui, 20, Buffer.from(ackResult.bytes));
            auditLogger.log('waveform_manager', 'data_ack', devEui, { fPort: 20, txId });
        } else {
            log.info(`Waveform ${devEui} TxID ${txId} Missing ${missing.length} segments`);
            // Request up to 20 missing segments per downlink (LoRaWAN payload limit).
            // If more than 20 are missing, the next batch will be requested once
            // the device resends these and checkRepairBatchComplete fires.
            const batch = missing.slice(0, 20);
            const maxIdx = Math.max(...batch);
            const reqResult = codec.encodeDownlink({
                fPort: 21,
                data: { value_size_mode: maxIdx > 0xFF ? 1 : 0, segments: batch }
            });
            this.sendAutoDownlink(devEui, 21, Buffer.from(reqResult.bytes));
            auditLogger.log('waveform_manager', 'missing_segment_req', devEui, { fPort: 21, txId, totalMissing: missing.length, batchSize: batch.length, segments: batch });

            // Track only the batch we actually requested so checkRepairBatchComplete
            // knows when to trigger the next checkCompletion.
            await pool.query(`
                UPDATE waveforms SET requested_segments = $1 WHERE id = $2
            `, [JSON.stringify(batch), waveformId]);

            // If the device never returns the full batch, re-request after 5 minutes.
            this._scheduleRepairTimeout(devEui, txId, waveformId);
        }
    }

    async checkRepairBatchComplete(devEui, txId, waveformId) {
        // Only act when there are outstanding requested segments
        const wfRes = await pool.query(
            `SELECT requested_segments FROM waveforms WHERE id = $1`,
            [waveformId]
        );
        const requested = wfRes.rows[0]?.requested_segments;
        if (!requested || requested.length === 0) return;

        // Check how many of the requested segments have now been received
        const segRes = await pool.query(
            `SELECT segment_index FROM waveform_segments
             WHERE waveform_id = $1 AND segment_index = ANY($2::int[])`,
            [waveformId, requested]
        );
        if (segRes.rows.length >= requested.length) {
            // All segments in this batch have arrived — cancel the repair timeout,
            // clear the batch record, and re-run checkCompletion to either finish
            // or request the next batch.
            if (this.repairTimeouts.has(waveformId)) {
                clearTimeout(this.repairTimeouts.get(waveformId));
                this.repairTimeouts.delete(waveformId);
            }
            await pool.query(
                `UPDATE waveforms SET requested_segments = '[]' WHERE id = $1`,
                [waveformId]
            );
            await this.checkCompletion(devEui, txId, waveformId);
        }
    }

    async assembleWaveform(waveformId) {
        const res = await pool.query(`
            SELECT data FROM waveform_segments
            WHERE waveform_id = $1
            ORDER BY segment_index ASC
        `, [waveformId]);

        const fullBuffer = Buffer.concat(res.rows.map(r => r.data));

        // Store as BYTEA (final_data_bytes) — halves storage cost vs JSONB hex string.
        // final_data is set to NULL for new rows; old rows retain their JSONB value
        // and are handled via fallback in the read endpoints.
        await pool.query(`
            UPDATE waveforms
            SET status = 'complete', final_data_bytes = $1, final_data = NULL
            WHERE id = $2
        `, [fullBuffer, waveformId]);

        // Fire-and-forget: compute and persist spectra.  Never throws to this path.
        spectrumProcessor.processWaveform(waveformId);
    }

    async findPendingWaveformId(devEui, txId) {
        const res = await pool.query(`
            SELECT id FROM waveforms
            WHERE device_eui = $1 AND transaction_id = $2 AND status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
        `, [devEui, txId]);
        return res.rows[0]?.id;
    }

    canSendAutoDownlink(devEui) {
        const now = Date.now();
        const timestamps = this.lastDownlinkTimes.get(devEui) || [];
        // Prune timestamps older than 60s
        const recent = timestamps.filter(t => now - t < 60000);
        this.lastDownlinkTimes.set(devEui, recent);
        // Max 1 downlink per minute per device — matches Class A constraint
        // (device can only receive one downlink per uplink cycle)
        return recent.length < 1;
    }

    recordAutoDownlink(devEui) {
        const timestamps = this.lastDownlinkTimes.get(devEui) || [];
        timestamps.push(Date.now());
        this.lastDownlinkTimes.set(devEui, timestamps);
    }

    sendAutoDownlink(devEui, port, payload) {
        if (!this.canSendAutoDownlink(devEui)) {
            log.info(`Rate-limited: skipping downlink to ${devEui} fPort ${port} (max 1/min — Class A queue protection)`);
            return;
        }
        this.recordAutoDownlink(devEui);
        this.sendDownlink(devEui, port, payload);
    }

    sendDownlink(devEui, port, payload) {
        const topic = `mqtt/things/${devEui}/downlink`;

        const message = JSON.stringify({
            DevEUI_downlink: {
                DevEUI: devEui,
                FPort: port,
                payload_hex: payload.toString('hex')
            }
        });

        // Lazy load mqttClient to avoid circular dependency
        const mqttClient = require('../mqttClient');
        mqttClient.publish(topic, message);
        log.info(`Downlink sent to ${devEui} on topic ${topic}: ${message}`);
    }

    _scheduleRepairTimeout(devEui, txId, waveformId) {
        // Clear any prior timeout for this waveform before setting a fresh one.
        if (this.repairTimeouts.has(waveformId)) {
            clearTimeout(this.repairTimeouts.get(waveformId));
        }
        const handle = setTimeout(async () => {
            this.repairTimeouts.delete(waveformId);
            try {
                const res = await pool.query(
                    `SELECT requested_segments, status FROM waveforms WHERE id = $1`,
                    [waveformId]
                );
                const wf = res.rows[0];
                if (!wf || wf.status !== 'pending') return;
                if (!wf.requested_segments || wf.requested_segments.length === 0) return;
                // Batch still outstanding — re-run checkCompletion to re-request.
                log.info(`Repair timeout for ${devEui} TxID ${txId} (waveform ${waveformId}), re-requesting missing segments`);
                await this.checkCompletion(devEui, txId, waveformId);
            } catch (err) {
                log.error({ err }, `Repair timeout error for waveform ${waveformId}`);
            }
        }, 5 * 60 * 1000); // 5 minutes
        this.repairTimeouts.set(waveformId, handle);
    }

    startCleanupJob() {
        // Configurable TTL for failed/aborted rows (default 7 days).
        // Segments are cascade-deleted. final_data_bytes (BYTEA/TOAST) is reclaimed immediately.
        const failedTtlDays = Math.max(1, parseInt(process.env.WAVEFORMS_FAILED_TTL_DAYS) || 7);

        setInterval(async () => {
            try {
                // Mark stale pending waveforms as failed
                const res = await pool.query(`
                    UPDATE waveforms
                    SET status = 'failed', last_updated = NOW()
                    WHERE status = 'pending'
                    AND last_updated < NOW() - INTERVAL '30 minutes'
                    RETURNING id, device_eui, transaction_id
                `);
                for (const row of res.rows) {
                    log.info(`Marked stale waveform ${row.id} failed (${row.device_eui} TxID ${row.transaction_id})`);
                    auditLogger.log('waveform_manager', 'waveform_stale_failed', row.device_eui, {
                        waveformId: row.id,
                        txId: row.transaction_id,
                    });
                }

                // Purge old failed/aborted waveforms to prevent unbounded storage growth.
                // Segments are cascade-deleted via ON DELETE CASCADE on waveform_segments.
                const purgeRes = await pool.query(`
                    DELETE FROM waveforms
                    WHERE status IN ('failed', 'aborted')
                    AND last_updated < NOW() - ($1 || ' days')::INTERVAL
                    RETURNING id, device_eui, transaction_id, status
                `, [failedTtlDays]);
                for (const row of purgeRes.rows) {
                    log.info(`Purged ${row.status} waveform ${row.id} (${row.device_eui} TxID ${row.transaction_id}) after ${failedTtlDays}d`);
                    auditLogger.log('waveform_manager', 'waveform_purged', row.device_eui, {
                        waveformId: row.id,
                        txId: row.transaction_id,
                        status: row.status,
                        ttlDays: failedTtlDays,
                    });
                }
            } catch (e) {
                log.error({ err: e }, 'Cleanup job error');
            }
        }, 5 * 60 * 1000); // Every 5 mins
    }

    startTWIUCheckJob() {
        setInterval(async () => {
            try {
                const res = await pool.query(`
                    SELECT id, device_eui, transaction_id FROM waveforms
                    WHERE status = 'pending'
                    AND metadata IS NULL
                    AND last_updated < NOW() - INTERVAL '60 seconds'
                    AND created_at > NOW() - INTERVAL '5 minutes'
                `);

                for (const row of res.rows) {
                    log.info(`Requesting missing TWIU for ${row.device_eui} TxID ${row.transaction_id}`);
                    // Request waveform info via codec (port 22, command: request_waveform_info)
                    const result = codec.encodeDownlink({
                        fPort: 22,
                        data: { command_id: 'request_waveform_info', parameters: [] }
                    });
                    this.sendAutoDownlink(row.device_eui, 22, Buffer.from(result.bytes));
                    auditLogger.log('waveform_manager', 'twiu_retry_req', row.device_eui, { fPort: 22, txId: row.transaction_id });

                    await pool.query(`UPDATE waveforms SET last_updated = NOW() WHERE id = $1`, [row.id]);
                }
            } catch (e) {
                log.error({ err: e }, 'TWIU Check job error');
            }
        }, 10 * 1000); // Every 10 seconds
    }
}

module.exports = new WaveformManager();
