'use strict';

const dotenv = require('dotenv');
dotenv.config();

const { server, io } = require('./app');
const { connectWithRetry } = require('./db');
const apiKeyManager = require('./services/ApiKeyManager');
const fuotaManager = require('./services/FUOTAManager');
const waveformManager = require('./services/WaveformManager');
const mqttClient = require('./mqttClient');
const pki = require('./pki');

const port = process.env.PORT || 4000;
const domain = process.env.DOMAIN || 'localhost';

// ---------------------------------------------------------------------------
// Startup — connect to infrastructure, then begin listening
// ---------------------------------------------------------------------------

(async () => {
    await connectWithRetry();

    // If a bootstrap key is configured, insert it idempotently so the first
    // operator can always authenticate even before creating keys via the API.
    const bootstrapKey = process.env.BOOTSTRAP_API_KEY;
    if (bootstrapKey) {
        try {
            await apiKeyManager.bootstrapKey(bootstrapKey, 'bootstrap');
            console.log('Bootstrap API key registered');
        } catch (e) {
            console.error('Failed to register bootstrap API key:', e);
        }
    }

    await fuotaManager.init(io);

    const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    mqttClient.connect(MQTT_BROKER_URL, io, (topic, msg) => {
        waveformManager.processPacket(topic, msg);
        fuotaManager.processPacket(topic, msg);
    });

    try {
        console.log(`Checking/Initializing PKI for domain: ${domain}`);
        await pki.generateCA(domain);
        await pki.generateServerCert(domain);
        console.log('PKI Initialized');
    } catch (e) {
        console.error('Failed to initialize PKI:', e);
    }
})();

server.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});
