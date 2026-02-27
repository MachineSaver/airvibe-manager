const mqtt = require('mqtt');
const messageTracker = require('./services/MessageTracker');
const log = require('./logger').child({ module: 'mqttClient' });

const NETWORK_SERVER = process.env.NETWORK_SERVER || 'chirpstack';
const adapter = NETWORK_SERVER === 'thingpark'
    ? require('./adapters/thingpark')
    : require('./adapters/chirpstack');
log.info(`MQTT adapter: ${NETWORK_SERVER}`);

let client = null;

function connect(brokerUrl, io, onMessage) {
    log.info(`Connecting to MQTT Broker at ${brokerUrl}`);

    client = mqtt.connect(brokerUrl, {
        clientId: 'mqtt-manager-backend_' + Math.random().toString(16).substring(2, 10),
        reconnectPeriod: 1000,
        ...(process.env.MQTT_USER ? { username: process.env.MQTT_USER } : {}),
        ...(process.env.MQTT_PASS ? { password: process.env.MQTT_PASS } : {}),
    });

    client.on('connect', () => {
        log.info('Connected to MQTT Broker');
        io.emit('mqtt:status', { connected: true });

        // Subscribe to all topics for full broker visibility
        client.subscribe('#', (err) => {
            if (err) {
                log.error({ err }, 'Failed to subscribe to #');
            } else {
                log.info('Subscribed to all topics (#)');
            }
        });
    });

    client.on('message', (rawTopic, rawMessage) => {
        // Run the incoming message through the active adapter to normalise it
        // into the internal canonical format. In ChirpStack mode this converts
        // application/{id}/device/{devEUI}/event/up → mqtt/things/{devEUI}/uplink.
        // In ThingPark mode the message is already canonical — passthrough.
        const { topic, message } = adapter.normalizeIncoming(rawTopic, rawMessage);

        io.emit('mqtt:message', {
            topic,
            payload:   message.toString(),
            timestamp: new Date().toISOString(),
        });

        messageTracker.trackMessage(topic, message).catch(e =>
            log.error({ err: e }, 'MessageTracker error')
        );

        if (onMessage) {
            try { onMessage(topic, message); } catch (e) {
                log.error({ err: e }, 'onMessage callback error');
            }
        }
    });

    client.on('error', (err) => {
        log.error({ err }, 'MQTT Error');
        io.emit('mqtt:status', { connected: false, error: err.message });
    });

    client.on('offline', () => {
        log.info('MQTT Client Offline');
        io.emit('mqtt:status', { connected: false });
    });
}

/**
 * Publish a message.
 *
 * The active adapter translates the topic/payload before writing to the broker:
 *   - chirpstack: converts mqtt/things/{devEUI}/downlink → ChirpStack command/down (base64 payload)
 *   - thingpark:  passthrough — publishes to mqtt/things/{devEUI}/downlink as-is (DevEUI_downlink JSON)
 */
function publish(topic, message) {
    if (!client || !client.connected) {
        throw new Error('MQTT Client not connected');
    }
    const { topic: outTopic, message: outMessage } = adapter.normalizeOutgoing(topic, message);
    client.publish(outTopic, outMessage);
}

function isConnected() {
    return client?.connected === true;
}

module.exports = { connect, publish, isConnected };
