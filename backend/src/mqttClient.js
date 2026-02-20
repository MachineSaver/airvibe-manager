const mqtt = require('mqtt');
const messageTracker = require('./services/MessageTracker');
const adapter = require('./adapters/chirpstack');

let client = null;

function connect(brokerUrl, io, onMessage) {
    console.log(`Connecting to MQTT Broker at ${brokerUrl}`);

    client = mqtt.connect(brokerUrl, {
        clientId: 'mqtt-manager-backend_' + Math.random().toString(16).substr(2, 8),
        reconnectPeriod: 1000,
    });

    client.on('connect', () => {
        console.log('Connected to MQTT Broker');
        io.emit('mqtt:status', { connected: true });

        // Subscribe to all topics for full broker visibility
        client.subscribe('#', (err) => {
            if (err) {
                console.error('Failed to subscribe to #', err);
            } else {
                console.log('Subscribed to all topics (#)');
            }
        });
    });

    client.on('message', (rawTopic, rawMessage) => {
        // Normalize ChirpStack uplink/downlink-echo topics and payloads into
        // the internal canonical format. Non-ChirpStack topics pass through
        // unchanged so the monitor still shows gateway stats, join events, etc.
        const { topic, message } = adapter.normalizeIncoming(rawTopic, rawMessage);

        io.emit('mqtt:message', {
            topic,
            payload:   message.toString(),
            timestamp: new Date().toISOString(),
        });

        messageTracker.trackMessage(topic, message).catch(e =>
            console.error('MessageTracker error:', e)
        );

        if (onMessage) {
            try { onMessage(topic, message); } catch (e) {
                console.error('onMessage callback error:', e);
            }
        }
    });

    client.on('error', (err) => {
        console.error('MQTT Error:', err);
        io.emit('mqtt:status', { connected: false, error: err.message });
    });

    client.on('offline', () => {
        console.log('MQTT Client Offline');
        io.emit('mqtt:status', { connected: false });
    });
}

/**
 * Publish a message.
 *
 * Internal downlink messages (topic `mqtt/things/{devEUI}/downlink` carrying
 * a DevEUI_downlink JSON body) are translated to ChirpStack command format
 * before being written to the broker. All other topics are published as-is.
 */
function publish(topic, message) {
    if (!client || !client.connected) {
        throw new Error('MQTT Client not connected');
    }
    const { topic: outTopic, message: outMessage } = adapter.normalizeOutgoing(topic, message);
    client.publish(outTopic, outMessage);
}

module.exports = { connect, publish };
