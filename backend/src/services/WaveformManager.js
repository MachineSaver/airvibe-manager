const { pool } = require('../db');
const codec = require('../codec/AirVibe_TS013_Codec');

class WaveformManager {
    constructor() {
        this.startCleanupJob();
        this.startTWIUCheckJob();
        this.lastDownlinkTimes = new Map();
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
            console.error('Error processing packet:', err);
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
                console.log(`Aborted stale waveform ${row.id} (TxID ${row.transaction_id}) for ${devEui}, superseded by TxID ${newTxId}`);
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
            // If this waveform already has metadata, it's a TxID reuse (rollover cycle).
            // Abort the old one and create a fresh row.
            const existing = await pool.query(`SELECT metadata FROM waveforms WHERE id = $1`, [waveformId]);
            if (existing.rows[0]?.metadata) {
                await pool.query(`UPDATE waveforms SET status = 'aborted' WHERE id = $1`, [waveformId]);
                console.log(`Aborted reused TxID ${txId} waveform ${waveformId} for ${devEui}, creating fresh row`);
                waveformId = null;
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

        console.log(`TWIU received for ${devEui} TxID ${txId}`);

        // Send ACK via codec
        const ackResult = codec.encodeDownlink({
            fPort: 20,
            data: { opcode: 'waveform_info_ack', transaction_id: txId }
        });
        this.sendDownlink(devEui, 20, Buffer.from(ackResult.bytes));
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
            console.log(`Waveform ${devEui} TxID ${txId} Complete!`);

            // Send Data ACK via codec
            const ackResult = codec.encodeDownlink({
                fPort: 20,
                data: { opcode: 'waveform_data_ack', transaction_id: txId }
            });
            this.sendDownlink(devEui, 20, Buffer.from(ackResult.bytes));
        } else {
            console.log(`Waveform ${devEui} TxID ${txId} Missing ${missing.length} segments`);
            // Request missing segments via codec
            const maxIdx = Math.max(...missing);
            const reqResult = codec.encodeDownlink({
                fPort: 21,
                data: { value_size_mode: maxIdx > 254 ? 1 : 0, segments: missing }
            });
            this.sendAutoDownlink(devEui, 21, Buffer.from(reqResult.bytes));

            // Track which segments were requested
            await pool.query(`
                UPDATE waveforms SET requested_segments = $1 WHERE id = $2
            `, [JSON.stringify(missing), waveformId]);
        }
    }

    async assembleWaveform(waveformId) {
        const res = await pool.query(`
            SELECT data FROM waveform_segments
            WHERE waveform_id = $1
            ORDER BY segment_index ASC
        `, [waveformId]);

        const fullBuffer = Buffer.concat(res.rows.map(r => r.data));

        await pool.query(`
            UPDATE waveforms
            SET status = 'complete', final_data = $1
            WHERE id = $2
        `, [JSON.stringify({ raw_hex: fullBuffer.toString('hex') }), waveformId]);
    }

    async findPendingWaveformId(devEui, txId) {
        const res = await pool.query(`
            SELECT id FROM waveforms
            WHERE device_eui = $1 AND transaction_id = $2 AND status = 'pending'
            ORDER BY created_at DESC
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
        return recent.length < 2;
    }

    recordAutoDownlink(devEui) {
        const timestamps = this.lastDownlinkTimes.get(devEui) || [];
        timestamps.push(Date.now());
        this.lastDownlinkTimes.set(devEui, timestamps);
    }

    sendAutoDownlink(devEui, port, payload) {
        if (!this.canSendAutoDownlink(devEui)) {
            console.log(`Rate-limited: skipping automated downlink for ${devEui} (max 2/min)`);
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
        console.log(`Downlink sent to ${devEui} on topic ${topic}: ${message}`);
    }

    startCleanupJob() {
        setInterval(async () => {
            try {
                const res = await pool.query(`
                    DELETE FROM waveforms
                    WHERE status = 'pending'
                    AND last_updated < NOW() - INTERVAL '30 minutes'
                `);
                if (res.rowCount > 0) console.log(`Cleaned up ${res.rowCount} stale waveforms`);
            } catch (e) {
                console.error('Cleanup job error:', e);
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
                    AND last_updated < NOW() - INTERVAL '10 seconds'
                    AND created_at > NOW() - INTERVAL '5 minutes'
                `);

                for (const row of res.rows) {
                    console.log(`Requesting missing TWIU for ${row.device_eui} TxID ${row.transaction_id}`);
                    // Request waveform info via codec (port 22, command: request_waveform_info)
                    const result = codec.encodeDownlink({
                        fPort: 22,
                        data: { command_id: 'request_waveform_info', parameters: [] }
                    });
                    this.sendAutoDownlink(row.device_eui, 22, Buffer.from(result.bytes));

                    await pool.query(`UPDATE waveforms SET last_updated = NOW() WHERE id = $1`, [row.id]);
                }
            } catch (e) {
                console.error('TWIU Check job error:', e);
            }
        }, 10 * 1000); // Every 10 seconds
    }
}

module.exports = new WaveformManager();
