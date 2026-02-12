const { pool } = require('../db');

// Helper to parse hex string to buffer
const hexToBuffer = (hex) => Buffer.from(hex, 'hex');

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

    async handleTWIU(devEui, txId, buffer) {
        // Parse TWIU
        // 03 [TxID] [SegNum(2)] [AxisSel] [Err] [NumSegs] [Filter] [SR(2)] [Samples(2)]
        const numSegments = buffer[6];
        const sampleRate = buffer.readUInt16BE(8);
        const samplesPerAxis = buffer.readUInt16BE(10);
        const axisSelection = buffer[4];

        const metadata = {
            sampleRate,
            samplesPerAxis,
            axisSelection,
            numSegments
        };

        // Find existing pending waveform or create new
        let waveformId = await this.findPendingWaveformId(devEui, txId);

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

        // Send ACK TWIU: 03 + TxID
        const ackPayload = Buffer.from([0x03, txId]);
        this.sendDownlink(devEui, 20, ackPayload);
    }

    async handleDataSegment(devEui, txId, buffer, isLast) {
        const segmentIndex = buffer.readUInt16BE(2);
        const data = buffer.subarray(4); // Payload starts at byte 4

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
        `, [waveformId, segmentIndex, data]);

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

            // Send Data ACK: 01 + TxID
            const ackPayload = Buffer.from([0x01, txId]);
            this.sendDownlink(devEui, 20, ackPayload);
        } else {
            console.log(`Waveform ${devEui} TxID ${txId} Missing ${missing.length} segments`);
            // Request Missing
            // Payload: 02 + [Indices]
            const maxIndex = Math.max(...missing);
            const useTwoBytes = maxIndex > 254;

            const payloadLen = 1 + (missing.length * (useTwoBytes ? 2 : 1));
            const payload = Buffer.alloc(payloadLen);
            payload[0] = 0x02;

            let offset = 1;
            for (const idx of missing) {
                if (useTwoBytes) {
                    payload.writeUInt16BE(idx, offset);
                    offset += 2;
                } else {
                    payload.writeUInt8(idx, offset);
                    offset += 1;
                }
            }
            this.sendDownlink(devEui, 21, payload);
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
                    const payload = Buffer.from([0x00, 0x01]);
                    this.sendDownlink(row.device_eui, 22, payload);

                    await pool.query(`UPDATE waveforms SET last_updated = NOW() WHERE id = $1`, [row.id]);
                }
            } catch (e) {
                console.error('TWIU Check job error:', e);
            }
        }, 10 * 1000); // Every 10 seconds
    }
}

module.exports = new WaveformManager();
