const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const mqttClient = require('./mqttClient');
const pki = require('./pki');
const { connectWithRetry, pool } = require('./db');
const waveformManager = require('./services/WaveformManager');

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

// Initialize services
(async () => {
    // Connect to Postgres
    await connectWithRetry();

    // Initialize MQTT Client with waveform processing callback
    const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    mqttClient.connect(MQTT_BROKER_URL, io, (topic, msg) => {
        waveformManager.processPacket(topic, msg);
    });

    // Auto-initialize PKI
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
    if (!/^[a-zA-Z0-9._-]+$/.test(clientId) || clientId.length > 253) {
        return res.status(400).json({ success: false, error: 'clientId must contain only alphanumeric characters, hyphens, underscores, and dots (max 253 chars)' });
    }
    try {
        const result = await pki.generateClientCert(clientId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Waveform API endpoints
app.get('/api/waveforms', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, device_eui, transaction_id, start_time, status,
                   expected_segments, received_segments_count, metadata, created_at
            FROM waveforms ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/waveforms/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const wfRes = await pool.query(`SELECT * FROM waveforms WHERE id = $1`, [id]);
        if (wfRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

        const segRes = await pool.query(
            `SELECT segment_index FROM waveform_segments WHERE waveform_id = $1 ORDER BY segment_index`,
            [id]
        );

        const waveform = wfRes.rows[0];
        waveform.segments = segRes.rows.map(r => r.segment_index);
        res.json(waveform);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/waveforms/:id/download', async (req, res) => {
    try {
        const { id } = req.params;
        const wfRes = await pool.query(`SELECT * FROM waveforms WHERE id = $1 AND status = 'complete'`, [id]);
        if (wfRes.rows.length === 0) return res.status(404).json({ error: 'Not found or not complete' });

        const waveform = wfRes.rows[0];
        res.setHeader('Content-Disposition', `attachment; filename=waveform_${waveform.device_eui}_${waveform.transaction_id}.json`);
        res.json({
            device_eui: waveform.device_eui,
            transaction_id: waveform.transaction_id,
            metadata: waveform.metadata,
            final_data: waveform.final_data,
            completed_at: waveform.last_updated
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
