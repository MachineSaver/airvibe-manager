const { pool } = require('../db');

const TOPIC_REGEX = /^mqtt\/things\/([^/]+)\/(uplink|downlink)$/;

class MessageTracker {
    constructor() {
        this.startRetentionCleanup();
    }

    async trackMessage(topic, message) {
        const match = topic.match(TOPIC_REGEX);
        if (!match) return;

        const devEui = match[1];
        const direction = match[2];

        let parsed = null;
        let payloadHex = null;
        let fPort = null;
        let packetType = null;

        try {
            parsed = JSON.parse(message.toString());
        } catch {
            parsed = { raw: message.toString() };
        }

        if (direction === 'uplink' && parsed.DevEUI_uplink) {
            payloadHex = parsed.DevEUI_uplink.payload_hex || null;
            fPort = parsed.DevEUI_uplink.FPort != null ? parseInt(parsed.DevEUI_uplink.FPort) : null;
            if (payloadHex && payloadHex.length >= 2) {
                packetType = parseInt(payloadHex.substring(0, 2), 16);
            }
        } else if (direction === 'downlink' && parsed.DevEUI_downlink) {
            payloadHex = parsed.DevEUI_downlink.payload_hex || null;
            fPort = parsed.DevEUI_downlink.FPort != null ? parseInt(parsed.DevEUI_downlink.FPort) : null;
            // No packet_type for downlinks — identified by fPort
        }

        try {
            await this.upsertDevice(devEui, direction);
            await pool.query(
                `INSERT INTO messages (device_eui, topic, direction, payload, payload_hex, fport, packet_type)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [devEui, topic, direction, JSON.stringify(parsed), payloadHex, fPort, packetType]
            );
        } catch (err) {
            console.error('MessageTracker error:', err.message);
        }
    }

    async upsertDevice(devEui, direction) {
        const directionCol = direction === 'uplink' ? 'last_uplink_at' : 'last_downlink_at';
        const countCol = direction === 'uplink' ? 'uplink_count' : 'downlink_count';

        await pool.query(
            `INSERT INTO devices (dev_eui, first_seen, last_seen, ${directionCol}, ${countCol})
             VALUES ($1, NOW(), NOW(), NOW(), 1)
             ON CONFLICT (dev_eui) DO UPDATE SET
                last_seen = NOW(),
                ${directionCol} = NOW(),
                ${countCol} = devices.${countCol} + 1`,
            [devEui]
        );
    }

    startRetentionCleanup() {
        const timer = setInterval(async () => {
            try {
                const res = await pool.query(
                    `DELETE FROM messages WHERE received_at < NOW() - INTERVAL '30 days'`
                );
                if (res.rowCount > 0) {
                    console.log(`MessageTracker: cleaned up ${res.rowCount} old messages`);
                }
            } catch (err) {
                console.error('MessageTracker retention cleanup error:', err.message);
            }
        }, 24 * 60 * 60 * 1000); // Every 24 hours
        timer.unref(); // Don't prevent process exit (e.g. during tests)
    }
}

module.exports = new MessageTracker();
