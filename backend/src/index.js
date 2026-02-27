'use strict';

const dotenv = require('dotenv');
dotenv.config();

const log = require('./logger').child({ module: 'startup' });
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
            log.info('Bootstrap API key registered');
        } catch (e) {
            log.error({ err: e }, 'Failed to register bootstrap API key');
        }
    }

    // Start MQTT connection before FUOTA init so that _waitForMqtt() in the
    // recovery loop has an active connection to poll against.
    const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    mqttClient.connect(MQTT_BROKER_URL, io, (topic, msg) => {
        waveformManager.processPacket(topic, msg);
        fuotaManager.processPacket(topic, msg);
    });

    await fuotaManager.init(io);

    try {
        log.info(`Checking/Initializing PKI for domain: ${domain}`);
        await pki.generateCA(domain);
        await pki.generateServerCert(domain);
        log.info('PKI Initialized');
    } catch (e) {
        log.error({ err: e }, 'Failed to initialize PKI');
    }
})();

server.listen(port, () => {
    log.info(`Backend server listening on port ${port}`);
});
