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

        // Persist ISM band derived from uplink Frequency on every uplink.
        // Frequency is set by the network server from actual radio parameters —
        // it is present on every uplink regardless of fPort/packet_type, cannot be
        // misconfigured, and the ISM band frequency ranges are globally non-overlapping.
        // This is used by FUOTAManager to select the correct per-device Class C profile.
        if (direction === 'uplink' && parsed.DevEUI_uplink?.Frequency != null) {
            const freq = parsed.DevEUI_uplink.Frequency;
            const ismBand =
                  (freq >= 863 && freq <= 870) ? 'EU868'   // ETSI 863-870 MHz
                : (freq >= 433 && freq <= 435) ? 'EU433'   // ETSI 433 MHz
                : (freq >= 902 && freq <= 928) ? 'US915'   // FCC  902-928 MHz (US915, AU915)
                : (freq >= 470 && freq <= 510) ? 'CN470'   // China 470-510 MHz
                : null;
            if (ismBand) {
                pool.query(
                    `UPDATE devices SET metadata = metadata || $1::jsonb WHERE dev_eui = $2`,
                    [JSON.stringify({ ism_band: ismBand }), devEui]
                ).catch(err => console.error('MessageTracker: ism_band update error:', err.message));
            }
        }

        // Type 4 config uplink (fPort 8, packet_type 0x04): parse TPM/VSM firmware
        // versions and push period from the AirVibe payload and persist to devices.metadata.
        // Codec: VSM fw at bytes 35-36 LE, TPM fw at bytes 37-38 LE, push_period_min at 8-9 LE.
        // fw(v) = (v >>> 8) + "." + (v & 0xFF)
        if (direction === 'uplink' && fPort === 8 && packetType === 4 && payloadHex) {
            const buf = Buffer.from(payloadHex, 'hex');
            if (buf.length >= 39) {
                const vsmRaw = buf[35] | (buf[36] << 8);
                const tpmRaw = buf[37] | (buf[38] << 8);
                const pushMin = buf[8]  | (buf[9]  << 8);
                const metaPatch = {
                    vsm_fw:           `${vsmRaw >>> 8}.${vsmRaw & 0xFF}`,
                    tpm_fw:           `${tpmRaw >>> 8}.${tpmRaw & 0xFF}`,
                    push_period_min:  pushMin,
                    config_updated_at: new Date().toISOString(),
                };
                pool.query(
                    `UPDATE devices SET metadata = metadata || $1::jsonb WHERE dev_eui = $2`,
                    [JSON.stringify(metaPatch), devEui]
                ).catch(err => console.error('MessageTracker: config metadata update error:', err.message));
            }
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
