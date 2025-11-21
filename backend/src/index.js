const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const mqttClient = require('./mqttClient');
const pki = require('./pki');

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Initialize MQTT Client
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
mqttClient.connect(MQTT_BROKER_URL, io);

// Auto-initialize PKI on startup
(async () => {
    const domain = process.env.DOMAIN || 'localhost';
    try {
        console.log(`Checking/Initializing PKI for domain: ${domain}`);
        await pki.generateCA(domain);
        await pki.generateServerCert(domain);
        console.log('PKI Initialized');
    } catch (e) {
        console.error('Failed to initialize PKI:', e);
    }
})();

app.get('/', (req, res) => {
    res.send('MQTT Manager Backend is running');
});

app.post('/api/certs/init', async (req, res) => {
    const domain = process.env.DOMAIN || 'localhost';
    try {
        console.log(`Initializing PKI for domain: ${domain}`);
        await pki.generateCA(domain);
        await pki.generateServerCert(domain);
        res.json({ success: true, message: 'CA and Server Certificates generated successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/certs/client', async (req, res) => {
    const { clientId } = req.body;
    if (!clientId) {
        return res.status(400).json({ success: false, error: 'clientId is required' });
    }
    try {
        const result = await pki.generateClientCert(clientId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

io.on('connection', (socket) => {
    console.log('Frontend connected via Socket.io');

    socket.on('publish', (data) => {
        try {
            mqttClient.publish(data.topic, data.payload);
        } catch (e) {
            console.error('Publish error:', e);
        }
    });
});

server.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});
