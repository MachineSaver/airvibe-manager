/**
 * chirpstack.js
 *
 * Bidirectional message adapter between ChirpStack v4 MQTT format and the
 * internal canonical format used by WaveformManager, FUOTAManager, and
 * MessageTracker.
 *
 * --- Uplink (ChirpStack → internal) ---
 * ChirpStack topic:   application/{appId}/device/{devEUI}/event/up
 * ChirpStack payload: { deviceInfo: { devEui }, fPort, fCnt, data (base64),
 *                       rxInfo: [{ rssi, snr }], time }
 *
 * Internal topic:     mqtt/things/{DEVEUI}/uplink
 * Internal payload:   { DevEUI_uplink: { DevEUI, FPort, FCntUp,
 *                         payload_hex, LrrRSSI, LrrSNR, Time } }
 *
 * --- Downlink command echo (ChirpStack → internal) ---
 * ChirpStack topic:   application/{appId}/device/{devEUI}/command/down
 * ChirpStack payload: { devEui, fPort, confirmed, data (base64) }
 *
 * Internal topic:     mqtt/things/{DEVEUI}/downlink
 * Internal payload:   { DevEUI_downlink: { DevEUI, FPort, payload_hex } }
 *
 * --- Downlink (internal → ChirpStack) ---
 * Internal topic:     mqtt/things/{DEVEUI}/downlink
 * Internal payload:   { DevEUI_downlink: { DevEUI, FPort, payload_hex } }
 *
 * ChirpStack topic:   application/{appId}/device/{devEUI}/command/down
 * ChirpStack payload: { devEui, confirmed, fPort, data (base64) }
 */

const log = require('../logger').child({ module: 'chirpstack-adapter' });

// Regex patterns for ChirpStack MQTT topics (v4 default template)
const CS_UPLINK_RE  = /^application\/([^/]+)\/device\/([^/]+)\/event\/up$/;
const CS_CMD_DOWN_RE = /^application\/([^/]+)\/device\/([^/]+)\/command\/down$/;
const INTERNAL_DOWN_RE = /^mqtt\/things\/([^/]+)\/downlink$/;

/**
 * Normalize an incoming MQTT message from ChirpStack format to internal format.
 *
 * For ChirpStack uplink and downlink-echo topics the return value has
 * { topic, message } in internal format. For all other topics the input is
 * returned unchanged so the MQTT monitor still shows gateway stats, join
 * events, etc. without modification.
 *
 * @param {string} topic
 * @param {Buffer} message
 * @returns {{ topic: string, message: Buffer }}
 */
function normalizeIncoming(topic, message) {
    // --- ChirpStack application uplink -----------------------------------------
    const upMatch = topic.match(CS_UPLINK_RE);
    if (upMatch) {
        const devEui = upMatch[2].toUpperCase();
        try {
            const cs = JSON.parse(message.toString());
            const payloadHex = cs.data
                ? Buffer.from(cs.data, 'base64').toString('hex')
                : '';
            const rxInfo = Array.isArray(cs.rxInfo) ? cs.rxInfo[0] : {};
            const normalized = {
                DevEUI_uplink: {
                    DevEUI: devEui,
                    FPort:  cs.fPort  ?? 0,
                    FCntUp: cs.fCnt   ?? 0,
                    payload_hex: payloadHex,
                    LrrRSSI: rxInfo.rssi ?? 0,
                    LrrSNR:  rxInfo.snr  ?? 0,
                    Time:    cs.time  || new Date().toISOString(),
                },
            };
            return {
                topic:   `mqtt/things/${devEui}/uplink`,
                message: Buffer.from(JSON.stringify(normalized)),
            };
        } catch (err) {
            log.warn(`chirpstack adapter: failed to parse uplink from ${topic}: ${err.message}`);
            return { topic, message };
        }
    }

    // --- ChirpStack downlink command echo (we published it; it bounces back) ---
    const cmdMatch = topic.match(CS_CMD_DOWN_RE);
    if (cmdMatch) {
        const devEui = cmdMatch[2].toUpperCase();
        try {
            const cs = JSON.parse(message.toString());
            const payloadHex = cs.data
                ? Buffer.from(cs.data, 'base64').toString('hex')
                : '';
            const normalized = {
                DevEUI_downlink: {
                    DevEUI:      devEui,
                    FPort:       cs.fPort ?? 0,
                    payload_hex: payloadHex,
                },
            };
            return {
                topic:   `mqtt/things/${devEui}/downlink`,
                message: Buffer.from(JSON.stringify(normalized)),
            };
        } catch (err) {
            log.warn(`chirpstack adapter: failed to parse command/down from ${topic}: ${err.message}`);
            return { topic, message };
        }
    }

    // Everything else (gateway stats, join events, txack, etc.) passes through
    // unchanged so the MQTT monitor shows the full broker picture.
    return { topic, message };
}

/**
 * Translate an outgoing internal downlink into ChirpStack command format.
 *
 * If the topic does not match the internal downlink pattern the input is
 * returned unchanged (e.g. for non-downlink publishes).
 *
 * @param {string} topic
 * @param {string|Buffer} message
 * @returns {{ topic: string, message: string }}
 */
function normalizeOutgoing(topic, message) {
    const downMatch = topic.match(INTERNAL_DOWN_RE);
    if (!downMatch) return { topic, message };

    const devEui = downMatch[1];
    const appId  = process.env.CHIRPSTACK_APPLICATION_ID || '1';

    try {
        const json = JSON.parse(message.toString());
        const dl   = json.DevEUI_downlink;
        if (!dl) return { topic, message };

        const csPayload = {
            devEui:    devEui.toLowerCase(),
            confirmed: !!(dl.Confirmed),
            fPort:     dl.FPort,
            data:      Buffer.from(dl.payload_hex || '', 'hex').toString('base64'),
        };

        return {
            topic:   `application/${appId}/device/${devEui.toLowerCase()}/command/down`,
            message: JSON.stringify(csPayload),
        };
    } catch (err) {
        log.warn(`chirpstack adapter: failed to translate downlink for ${topic}: ${err.message}`);
        return { topic, message };
    }
}

module.exports = { normalizeIncoming, normalizeOutgoing };
