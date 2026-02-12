const mqtt = require('mqtt');

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

        // Subscribe to all topics for monitoring
        client.subscribe('#', (err) => {
            if (err) {
                console.error('Failed to subscribe to #', err);
            } else {
                console.log('Subscribed to all topics (#)');
            }
        });
    });

    client.on('message', (topic, message) => {
        io.emit('mqtt:message', {
            topic,
            payload: message.toString(),
            timestamp: new Date().toISOString()
        });
        if (onMessage) {
            try { onMessage(topic, message); } catch (e) { console.error('onMessage callback error:', e); }
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

function publish(topic, message) {
    if (client && client.connected) {
        client.publish(topic, message);
    } else {
        throw new Error('MQTT Client not connected');
    }
}

module.exports = {
    connect,
    publish
};
