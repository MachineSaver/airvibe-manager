const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const mqttClient = require('./mqttClient');
const pki = require('./pki');
const { connectWithRetry, pool } = require('./db');
const waveformManager = require('./services/WaveformManager');
const demoSimulator = require('./services/DemoSimulator');

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

// Deinterleave raw hex waveform data into per-axis int16 sample arrays
function deinterleaveWaveform(rawHex, axisMask) {
    const buf = Buffer.from(rawHex, 'hex');
    const isTri = axisMask === 0x07;
    const isAxis1 = (axisMask & 0x01) !== 0;
    const isAxis2 = (axisMask & 0x02) !== 0;
    const isAxis3 = (axisMask & 0x04) !== 0;

    const axis1 = [], axis2 = [], axis3 = [];
    let offset = 0;
    while (offset < buf.length) {
        if (isTri) {
            if (offset + 6 > buf.length) break;
            axis1.push(buf.readInt16LE(offset));
            axis2.push(buf.readInt16LE(offset + 2));
            axis3.push(buf.readInt16LE(offset + 4));
            offset += 6;
        } else {
            if (offset + 2 > buf.length) break;
            const val = buf.readInt16LE(offset);
            if (isAxis1) axis1.push(val);
            else if (isAxis2) axis2.push(val);
            else if (isAxis3) axis3.push(val);
            offset += 2;
        }
    }
    return { axis1, axis2, axis3, isAxis1, isAxis2, isAxis3 };
}

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

// Specific sub-routes BEFORE the /:id catch-all
app.get('/api/waveforms/:id/download', async (req, res) => {
    try {
        const { id } = req.params;
        const wfRes = await pool.query(`SELECT * FROM waveforms WHERE id = $1 AND status = 'complete'`, [id]);
        if (wfRes.rows.length === 0) return res.status(404).json({ error: 'Not found or not complete' });

        const waveform = wfRes.rows[0];
        const meta = waveform.metadata;
        const rawHex = waveform.final_data?.raw_hex;
        if (!meta || !rawHex) return res.status(400).json({ error: 'Missing metadata or data' });

        const axisMask = meta.axisMask ?? meta.axisSelection;
        const sampleRate = meta.sampleRate;
        const { axis1, axis2, axis3, isAxis1, isAxis2, isAxis3 } = deinterleaveWaveform(rawHex, axisMask);
        const totalSamples = Math.max(axis1.length, axis2.length, axis3.length);

        // Build sample rows with time
        const samples = [];
        for (let i = 0; i < totalSamples; i++) {
            const row = { sample: i, time_s: parseFloat((i / sampleRate).toFixed(6)) };
            if (isAxis1) row.axis_1_accel_milligs = axis1[i];
            if (isAxis2) row.axis_2_accel_milligs = axis2[i];
            if (isAxis3) row.axis_3_accel_milligs = axis3[i];
            samples.push(row);
        }

        const txHex = waveform.transaction_id.toString(16).padStart(2, '0').toUpperCase();
        res.setHeader('Content-Disposition', `attachment; filename=waveform_tx${txHex}_${waveform.device_eui}.json`);
        res.json({
            device_eui: waveform.device_eui,
            transaction_id: waveform.transaction_id,
            axis_selection: meta.axisSelection || meta.axisMask,
            sample_rate_hz: sampleRate,
            samples_per_axis: meta.samplesPerAxis,
            hw_filter: meta.hwFilter || 'unknown',
            segments: `${waveform.received_segments_count}/${waveform.expected_segments}`,
            status: waveform.status,
            completed_at: waveform.last_updated,
            total_samples: totalSamples,
            samples,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/waveforms/:id/csv', async (req, res) => {
    try {
        const { id } = req.params;
        const wfRes = await pool.query(`SELECT * FROM waveforms WHERE id = $1 AND status = 'complete'`, [id]);
        if (wfRes.rows.length === 0) return res.status(404).json({ error: 'Not found or not complete' });

        const waveform = wfRes.rows[0];
        const meta = waveform.metadata;
        const rawHex = waveform.final_data?.raw_hex;
        if (!meta || !rawHex) return res.status(400).json({ error: 'Missing metadata or data' });

        const axisMask = meta.axisMask ?? meta.axisSelection;
        const axisLabel = meta.axisSelection || 'unknown';
        const hwFilter = meta.hwFilter || 'unknown';
        const sampleRate = meta.sampleRate;
        const samplesPerAxis = meta.samplesPerAxis;
        const txId = waveform.transaction_id;
        const txHex = txId.toString(16).padStart(2, '0').toUpperCase();

        const { axis1, axis2, axis3, isAxis1, isAxis2, isAxis3 } = deinterleaveWaveform(rawHex, axisMask);
        const totalSamples = Math.max(axis1.length, axis2.length, axis3.length);

        // Build CSV
        const lines = [];
        lines.push(`# AirVibe Waveform Export`);
        lines.push(`# Transaction ID: 0x${txHex} (${txId})`);
        lines.push(`# Axis Selection: ${axisLabel}`);
        lines.push(`# Sample Rate: ${sampleRate} Hz`);
        lines.push(`# Samples Per Axis: ${samplesPerAxis}`);
        lines.push(`# HW Filter: ${hwFilter}`);
        lines.push(`# Segments: ${waveform.received_segments_count}/${waveform.expected_segments}`);
        lines.push(`# Status: ${waveform.status === 'complete' ? 'Complete' : 'Incomplete'}`);
        lines.push('#');

        const colHeaders = ['sample', 'time_s'];
        if (isAxis1) colHeaders.push('axis_1_accel_milligs');
        if (isAxis2) colHeaders.push('axis_2_accel_milligs');
        if (isAxis3) colHeaders.push('axis_3_accel_milligs');
        lines.push(colHeaders.join(','));

        for (let i = 0; i < totalSamples; i++) {
            const time = (i / sampleRate).toFixed(6);
            const row = [i, time];
            if (isAxis1) row.push(axis1[i] ?? '');
            if (isAxis2) row.push(axis2[i] ?? '');
            if (isAxis3) row.push(axis3[i] ?? '');
            lines.push(row.join(','));
        }

        const csv = lines.join('\n') + '\n';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=waveform_tx${txHex}_${timestamp}.csv`);
        res.send(csv);
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

// Device Registry endpoints
app.get('/api/devices', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM devices ORDER BY last_seen DESC`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/devices/:devEui', async (req, res) => {
    try {
        const { devEui } = req.params;
        const result = await pool.query(`SELECT * FROM devices WHERE dev_eui = $1`, [devEui]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/devices/:devEui/messages', async (req, res) => {
    try {
        const { devEui } = req.params;
        const result = await pool.query(
            `SELECT * FROM messages WHERE device_eui = $1 ORDER BY received_at DESC LIMIT 200`,
            [devEui]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/messages', async (req, res) => {
    try {
        let limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        const conditions = [];
        const params = [];

        if (req.query.device_eui) {
            params.push(req.query.device_eui);
            conditions.push(`device_eui = $${params.length}`);
        }
        if (req.query.direction) {
            params.push(req.query.direction);
            conditions.push(`direction = $${params.length}`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        params.push(limit);

        const result = await pool.query(
            `SELECT * FROM messages ${where} ORDER BY received_at DESC LIMIT $${params.length}`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        const [devices, messages, lastHour, waveforms] = await Promise.all([
            pool.query(`SELECT COUNT(*) as count FROM devices`),
            pool.query(`SELECT COUNT(*) as count FROM messages`),
            pool.query(`SELECT COUNT(*) as count FROM messages WHERE received_at > NOW() - INTERVAL '1 hour'`),
            pool.query(`SELECT COUNT(*) as count FROM waveforms`),
        ]);
        res.json({
            total_devices: parseInt(devices.rows[0].count),
            total_messages: parseInt(messages.rows[0].count),
            messages_last_hour: parseInt(lastHour.rows[0].count),
            total_waveforms: parseInt(waveforms.rows[0].count),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Demo simulator endpoints
app.post('/api/demo/start', (req, res) => {
    const duration = Math.min(Math.max(parseFloat(req.body.duration) || 5, 1), 30);
    const result = demoSimulator.start(duration);
    if (result.error) return res.status(409).json(result);
    res.json(result);
});

app.post('/api/demo/stop', (req, res) => {
    const result = demoSimulator.stop();
    if (result.error) return res.status(409).json(result);
    res.json(result);
});

app.get('/api/demo/status', (req, res) => {
    res.json(demoSimulator.getStatus());
});

app.post('/api/demo/reset', async (req, res) => {
    if (demoSimulator.getStatus().running) {
        return res.status(409).json({ error: 'Stop the demo before resetting' });
    }
    try {
        await pool.query('TRUNCATE waveform_segments, waveforms, messages, devices CASCADE');
        res.json({ success: true, message: 'All data cleared' });
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
