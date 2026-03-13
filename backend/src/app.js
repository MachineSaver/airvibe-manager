'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const multer = require('multer');

const { pool } = require('./db');
const mqttClient = require('./mqttClient');
const pki = require('./pki');
const fuotaManager = require('./services/FUOTAManager');
const networkClient = require('./services/networkServerClient');
const demoSimulator = require('./services/DemoSimulator');
const auditLogger = require('./services/AuditLogger');
const apiKeyManager = require('./services/ApiKeyManager');
const { requireApiKey } = require('./middleware/auth');
const log = require('./logger').child({ module: 'app' });
const { deinterleaveWaveform } = require('./utils/deinterleave');
const { computeEnvelopeSpectrum } = require('./utils/fft');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./openapi');

// ---------------------------------------------------------------------------
// Express + Socket.io setup
// ---------------------------------------------------------------------------

const domain = process.env.DOMAIN || 'localhost';
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:4000',
    `https://${domain}`,
];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '10mb' }));
app.use(requireApiKey);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a parameterised WHERE clause from a filter spec.
 *
 * @param {Array<{ param: string, column: string }>} spec
 *   Each entry maps a req.query key to a DB column name. The operator is
 *   always equality except when column ends with '_gte' (>=) or '_lte' (<=),
 *   which are never exposed externally — instead the callers pass explicit
 *   `from`/`to` entries with the real column name and a custom op.
 * @param {object} query  req.query (or any plain object of filter values)
 * @param {Array}  params Existing param array to append to (mutated in place)
 * @param {Array<string>} [initial=[]] Starting WHERE conditions (e.g. hard-wired device_eui)
 * @returns {{ where: string, params: Array }}
 */
function buildWhereClause(spec, query, params, initial = []) {
    const conditions = [...initial];
    for (const { param, column, op = '=' } of spec) {
        if (query[param] !== undefined && query[param] !== '') {
            params.push(query[param]);
            conditions.push(`${column} ${op} $${params.length}`);
        }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
}

/**
 * Parse and clamp pagination params from req.query.
 * @returns {{ limit: number, offset: number }}
 */
function parsePagination(query, { maxLimit = 500, defaultLimit = 50 } = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit) || defaultLimit, 1), maxLimit);
    const offset = Math.max(parseInt(query.offset) || 0, 0);
    return { limit, offset };
}

/**
 * Run COUNT + paginated SELECT for a list endpoint. Sets X-Total-Count header.
 *
 * IMPORTANT: `table`, `select`, and `orderBy` are interpolated directly into the
 * SQL string — they MUST be hardcoded constants, never derived from user input.
 * All dynamic filter values must be passed through `params` (parameterised).
 *
 * @param {object} opts
 * @param {string}   opts.table     Table name (hardcoded — must not be user-supplied)
 * @param {string}   opts.select    Column list for SELECT (hardcoded — must not be user-supplied)
 * @param {string}   opts.orderBy   ORDER BY clause (hardcoded — must not be user-supplied)
 * @param {string}   opts.where     WHERE clause string (may be empty)
 * @param {Array}    opts.params    Bind params matching the WHERE clause
 * @param {number}   opts.limit
 * @param {number}   opts.offset
 * @param {object}   opts.res       Express response object (for header + json)
 */
async function sendPagedList({ table, select, orderBy, where, params, limit, offset, res }) {
    const countResult = await pool.query(
        `SELECT COUNT(*) AS count FROM ${table} ${where}`,
        params,
    );
    const total = parseInt(countResult.rows[0].count);

    const dataParams = [...params, limit, offset];
    const dataResult = await pool.query(
        `SELECT ${select} FROM ${table} ${where}
         ORDER BY ${orderBy}
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams,
    );

    res.setHeader('X-Total-Count', total);
    res.json(dataResult.rows);
}

// ---------------------------------------------------------------------------
// Multer — disk-storage upload (firmware binary)
// ---------------------------------------------------------------------------

const upload = multer({
    preservePath: true, // keep path separators in originalname so route can detect traversal
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, os.tmpdir()),
        // Strip path from temp filename — never let a client-supplied path escape tmpdir
        filename: (_req, file, cb) => cb(null, `fuota-${Date.now()}-${path.basename(file.originalname) || 'upload'}`),
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ---------------------------------------------------------------------------
// Routes — root
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
    res.send('AirVibe Manager Backend is running');
});

// ---------------------------------------------------------------------------
// Routes — PKI / certificates
// ---------------------------------------------------------------------------

app.post('/api/certs/init', async (req, res) => {
    try {
        await pki.generateCA(domain);
        await pki.generateServerCert(domain);
        auditLogger.log('pki', 'cert_init', null, { domain });
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
        auditLogger.log('pki', 'cert_client', null, { clientId });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const CERTS_DIR = process.env.CERTS_DIR || '/app/certs';

app.get('/api/certs/download/:filename', (req, res) => {
    const { filename } = req.params;
    if (!filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
        return res.status(400).json({ success: false, error: 'Invalid filename' });
    }
    const filePath = path.join(CERTS_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }
    auditLogger.log('pki', 'cert_download', null, { filename });
    res.download(filePath);
});

// ---------------------------------------------------------------------------
// Routes — health
// ---------------------------------------------------------------------------

app.get('/api/health', async (req, res) => {
    const checks = {};
    let allOk = true;

    try {
        await pool.query('SELECT 1');
        checks.postgres = { ok: true };
    } catch (err) {
        checks.postgres = { ok: false, error: err.message };
        allOk = false;
    }

    const mqttOk = mqttClient.isConnected();
    checks.mqtt = { ok: mqttOk };
    if (!mqttOk) allOk = false;

    checks.fuota = { activeSessions: fuotaManager.getActiveSessions().length };

    res.status(allOk ? 200 : 503).json({
        status: allOk ? 'ok' : 'degraded',
        uptime: Math.floor(process.uptime()),
        checks,
    });
});

// ---------------------------------------------------------------------------
// Routes — waveforms
// ---------------------------------------------------------------------------

// Filter spec for GET /api/waveforms (all waveforms, device_eui is optional).
const WAVEFORM_FILTER_SPEC = [
    { param: 'status',     column: 'status' },
    { param: 'device_eui', column: 'device_eui' },
    { param: 'from',       column: 'created_at', op: '>=' },
    { param: 'to',         column: 'created_at', op: '<=' },
];

// Filter spec for GET /api/devices/:devEui/waveforms (device_eui is a hard-wired
// path param, so it is intentionally absent here to avoid double-binding it).
const DEVICE_WAVEFORM_FILTER_SPEC = [
    { param: 'status', column: 'status' },
    { param: 'from',   column: 'created_at', op: '>=' },
    { param: 'to',     column: 'created_at', op: '<=' },
];

const WAVEFORM_SELECT_COLS =
    'id, device_eui, transaction_id, start_time, status, ' +
    'expected_segments, received_segments_count, metadata, created_at';

// Filter spec for GET /api/devices/:devEui/messages (device_eui is a hard-wired
// path param, so it is intentionally absent here to avoid double-binding it).
const DEVICE_MESSAGE_FILTER_SPEC = [
    { param: 'direction', column: 'direction' },
    { param: 'from',      column: 'received_at', op: '>=' },
    { param: 'to',        column: 'received_at', op: '<=' },
];

// Filter spec for GET /api/messages
const MESSAGE_FILTER_SPEC = [
    { param: 'device_eui', column: 'device_eui' },
    { param: 'direction',  column: 'direction' },
    { param: 'from',       column: 'received_at', op: '>=' },
    { param: 'to',         column: 'received_at', op: '<=' },
];

// Filter spec for GET /api/audit-log
const AUDIT_LOG_FILTER_SPEC = [
    { param: 'source',     column: 'source' },
    { param: 'action',     column: 'action' },
    { param: 'device_eui', column: 'device_eui' },
    { param: 'from',       column: 'created_at', op: '>=' },
    { param: 'to',         column: 'created_at', op: '<=' },
];

// GET /api/waveforms?status=&device_eui=&from=&to=&limit=&offset=
app.get('/api/waveforms', async (req, res) => {
    try {
        const params = [];
        const { where } = buildWhereClause(WAVEFORM_FILTER_SPEC, req.query, params);
        const { limit, offset } = parsePagination(req.query);
        await sendPagedList({
            table: 'waveforms', select: WAVEFORM_SELECT_COLS,
            orderBy: 'created_at DESC', where, params, limit, offset, res,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Specific sub-routes BEFORE the /:id catch-all.

app.get('/api/waveforms/:id/download', async (req, res) => {
    try {
        const { id } = req.params;
        const wfRes = await pool.query(`SELECT * FROM waveforms WHERE id = $1 AND status = 'complete'`, [id]);
        if (wfRes.rows.length === 0) return res.status(404).json({ error: 'Not found or not complete' });

        const waveform = wfRes.rows[0];
        const meta = waveform.metadata;
        const rawHex = waveform.final_data_bytes
            ? waveform.final_data_bytes.toString('hex')
            : waveform.final_data?.raw_hex;
        if (!meta || !rawHex) return res.status(400).json({ error: 'Missing metadata or data' });

        const axisMask = meta.axisMask ?? meta.axisSelection;
        const sampleRate = meta.sampleRate;
        const { axis1, axis2, axis3, isAxis1, isAxis2, isAxis3 } = deinterleaveWaveform(rawHex, axisMask);
        const totalSamples = Math.max(axis1.length, axis2.length, axis3.length);

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
        const rawHex = waveform.final_data_bytes
            ? waveform.final_data_bytes.toString('hex')
            : waveform.final_data?.raw_hex;
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
            [id],
        );

        const waveform = wfRes.rows[0];
        if (waveform.final_data_bytes) {
            waveform.final_data = { raw_hex: waveform.final_data_bytes.toString('hex') };
        }
        delete waveform.final_data_bytes;
        waveform.segments = segRes.rows.map(r => r.segment_index);
        res.json(waveform);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/waveforms/:id/spectra', async (req, res) => {
    try {
        const { id } = req.params;
        const wfRes = await pool.query(`SELECT id FROM waveforms WHERE id = $1`, [id]);
        if (wfRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

        const spRes = await pool.query(
            `SELECT axis, spectrum_type, num_bins, frequency_resolution_hz, frequencies, magnitudes
             FROM waveform_spectra WHERE waveform_id = $1
             ORDER BY axis, spectrum_type`,
            [id],
        );

        const spectra = spRes.rows.map(row => ({
            axis: row.axis,
            spectrumType: row.spectrum_type,
            numBins: row.num_bins,
            frequencyResolutionHz: row.frequency_resolution_hz,
            frequencies: _decodeFloat32Buffer(row.frequencies),
            magnitudes: _decodeFloat32Buffer(row.magnitudes),
        }));

        res.json(spectra);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/waveforms/:id/envelope', async (req, res) => {
    try {
        const { id } = req.params;
        const hp = parseFloat(req.query.hp);
        const lp = parseFloat(req.query.lp);

        if (!isFinite(hp) || !isFinite(lp) || hp < 0 || lp <= hp) {
            return res.status(400).json({ error: 'Invalid hp/lp: must be positive numbers with hp < lp' });
        }

        const result = await pool.query(
            `SELECT id, metadata, final_data_bytes, final_data FROM waveforms WHERE id = $1`,
            [id],
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

        const waveform = result.rows[0];
        const rawHex = waveform.final_data_bytes
            ? waveform.final_data_bytes.toString('hex')
            : waveform.final_data?.raw_hex;

        if (!rawHex) return res.json([]);

        const { axisMask, sampleRate } = waveform.metadata;
        const { axis1, axis2, axis3, isAxis1, isAxis2, isAxis3 } =
            deinterleaveWaveform(rawHex, axisMask);

        const axesData = [
            { samples: axis1, active: isAxis1, axisNum: 1 },
            { samples: axis2, active: isAxis2, axisNum: 2 },
            { samples: axis3, active: isAxis3, axisNum: 3 },
        ].filter(a => a.active);

        const spectra = axesData.map(({ samples, axisNum }) => {
            const { frequencies, magnitudes, numBins, freqResHz } =
                computeEnvelopeSpectrum(samples, sampleRate, hp, lp);
            return {
                axis: axisNum,
                frequencies: Array.from(frequencies),
                magnitudes:  Array.from(magnitudes),
                numBins,
                frequencyResolutionHz: freqResHz,
            };
        });

        res.json(spectra);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Routes — devices
// ---------------------------------------------------------------------------

app.get('/api/devices', async (req, res) => {
    try {
        const { limit, offset } = parsePagination(req.query);
        await sendPagedList({
            table: 'devices', select: '*',
            orderBy: 'last_seen DESC', where: '', params: [], limit, offset, res,
        });
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

// GET /api/devices/:devEui/waveforms?status=&from=&to=&limit=&offset=
app.get('/api/devices/:devEui/waveforms', async (req, res) => {
    try {
        const { devEui } = req.params;
        const params = [devEui];
        const { where } = buildWhereClause(
            DEVICE_WAVEFORM_FILTER_SPEC, req.query, params, ['device_eui = $1'],
        );
        const { limit, offset } = parsePagination(req.query);
        await sendPagedList({
            table: 'waveforms', select: WAVEFORM_SELECT_COLS,
            orderBy: 'created_at DESC', where, params, limit, offset, res,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/devices/:devEui/messages?direction=&from=&to=&limit=&offset=
app.get('/api/devices/:devEui/messages', async (req, res) => {
    try {
        const { devEui } = req.params;
        const params = [devEui];
        const { where } = buildWhereClause(
            DEVICE_MESSAGE_FILTER_SPEC, req.query, params, ['device_eui = $1'],
        );
        const { limit, offset } = parsePagination(req.query, { maxLimit: 1000, defaultLimit: 100 });
        await sendPagedList({
            table: 'messages', select: '*',
            orderBy: 'received_at DESC', where, params, limit, offset, res,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Packet-type / fPort label lookups
// ---------------------------------------------------------------------------

const UPLINK_PACKET_NAMES = {
    // ── Waveform packets ─────────────────────────────────────────────────────
    '8:1':  'TWD — Waveform Data Segment',
    '8:3':  'TWIU — Waveform Info Uplink',
    '8:5':  'TWF — Waveform Final Segment',
    // ── Vibration / status reports ───────────────────────────────────────────
    '8:2':  'Overall Vibration Report',
    '8:4':  'Sensor Configuration Report',
    '8:7':  'Alarm-Triggered Vibration Report',
    // ── FUOTA lifecycle ───────────────────────────────────────────────────────
    '8:16': 'FUOTA Init ACK',                         // 0x10 — device ACKs init downlink, ready to receive blocks
    '8:17': 'FUOTA Verification Response',            // 0x11 — device reports missed blocks (empty = all received, TPM begins flashing)
    '8:18': 'FUOTA Upgrade Status',                   // 0x12 — TPM reports result after 2-3 min flash write (success or fail)
    '8:19': 'FUOTA Stuck Timeout Error',              // 0x13 — US915 only: no downlinks received for 3 min during FUOTA
    // ── Waveform error ────────────────────────────────────────────────────────
    '8:21': 'Error — Waveform ACK Timeout',           // 0x15 — last TWF ACK downlink not received in time
    // ── Configuration subsystem errors ───────────────────────────────────────
    '8:22': 'Error — Config SPI Flash Init Failed',
    '8:23': 'Error — Config SPI Flash ID Read Failed',
    '8:24': 'Error — Config SPI Flash ID Unknown',
    '8:25': 'Error — Config SPI Flash Page Read Failed',
    '8:26': 'Error — Config SPI Flash Page Write Failed',
    '8:27': 'Error — Config Block Signature Invalid',
    '8:28': 'Error — Config Block Version Unsupported',
    '8:29': 'Error — Config Block CRC Bad',
    '8:30': 'Error — Config SPI Flash Erase Failed',
    '8:31': 'Error — Config Block Write Verification Failed',
    // ── Upgrade subsystem errors ──────────────────────────────────────────────
    '8:50': 'Error — Upgrade Subsystem Init Failed',
    '8:51': 'Error — Upgrade SPI Flash ID Read Failed',
    '8:52': 'Error — Upgrade SPI Flash ID Unknown',
    '8:53': 'Error — Upgrade SPI Flash Page Read Failed',
    '8:54': 'Error — Upgrade SPI Flash Page Write Failed',
    '8:55': 'Error — Upgrade SPI Flash Erase Failed',
    '8:57': 'Error — VSM Bootloader Transaction Size Bad',
    '8:58': 'Error — Upgrade Status Block Wrong Signature',
    '8:59': 'Error — Upgrade Status Block CRC Bad',
    '8:60': 'Error — SPI Flash Init Failed (generic)',
    '8:61': 'Error — SPI Flash ID Read Failed (generic)',
    '8:62': 'Error — SPI Flash ID Unknown (generic)',
    '8:71': 'Error — Upgrade Image Area Load Failed',
    '8:73': 'Error — UAIIB Signature Invalid',
    '8:74': 'Error — UAIIB CRC Bad',
    '8:75': 'Error — Upgrade Image CRC Mismatch',
    '8:76': 'Error — UAIIB Device ID Mismatch',
    '8:77': 'Error — Upgrade Image Size Invalid',
};

function uplinkPacketName(fport, packetType) {
    if (fport == null && packetType == null) return 'No Application Payload (MAC only)';
    const name = UPLINK_PACKET_NAMES[`${fport}:${packetType}`];
    return name ?? `Unknown (fPort ${fport}, 0x${(packetType ?? 0).toString(16).toUpperCase().padStart(2, '0')})`;
}

const DOWNLINK_FPORT_NAMES = {
    20: 'Waveform Control',
    21: 'Missing Segments Request',
    22: 'Command',
    25: 'FUOTA Block Data',
    30: 'Device Configuration',
    31: 'Alarm Configuration',
};

const DOWNLINK_CMD22_NAMES = {
    '01': 'Request Waveform Info',
    '02': 'Request Configuration',
    '03': 'Trigger New Capture',
    '05': 'Initialize FUOTA Session',
    '06': 'Verify FUOTA Data',
};

const DOWNLINK_CMD20_NAMES = {
    '01': 'TWD Acknowledge',
    '03': 'TWIU Acknowledge',
};

function downlinkFunctionName(fport, commandByte) {
    const base = DOWNLINK_FPORT_NAMES[fport] ?? `Unknown (fPort ${fport})`;
    if (fport === 22 && commandByte) {
        const sub = DOWNLINK_CMD22_NAMES[commandByte];
        return sub ? `${base}: ${sub}` : `${base}: Unknown (0x${commandByte.toUpperCase()})`;
    }
    if (fport === 20 && commandByte) {
        const sub = DOWNLINK_CMD20_NAMES[commandByte];
        return sub ? `${base}: ${sub}` : base;
    }
    return base;
}

// GET /api/devices/:devEui/uplink-stats
app.get('/api/devices/:devEui/uplink-stats', async (req, res) => {
    try {
        const { devEui } = req.params;
        const deviceCheck = await pool.query(
            'SELECT dev_eui FROM devices WHERE dev_eui = $1', [devEui],
        );
        if (deviceCheck.rows.length === 0) return res.status(404).json({ error: 'Device not found' });

        const result = await pool.query(
            `SELECT fport, packet_type, COUNT(*) AS count, MAX(received_at) AS last_received
             FROM messages
             WHERE device_eui = $1 AND direction = 'uplink'
             GROUP BY fport, packet_type
             ORDER BY count DESC`,
            [devEui],
        );
        res.json(result.rows.map(row => ({
            fport:         row.fport,
            packet_type:   row.packet_type,
            packet_name:   uplinkPacketName(row.fport, row.packet_type),
            count:         parseInt(row.count, 10),
            last_received: row.last_received,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/devices/:devEui/downlink-stats
app.get('/api/devices/:devEui/downlink-stats', async (req, res) => {
    try {
        const { devEui } = req.params;
        const deviceCheck = await pool.query(
            'SELECT dev_eui FROM devices WHERE dev_eui = $1', [devEui],
        );
        if (deviceCheck.rows.length === 0) return res.status(404).json({ error: 'Device not found' });

        const result = await pool.query(
            `SELECT
                 fport,
                 CASE
                     WHEN payload_hex IS NOT NULL AND length(payload_hex) >= 2
                     THEN lower(substring(payload_hex, 1, 2))
                     ELSE NULL
                 END AS command_byte,
                 COUNT(*) AS count,
                 MAX(received_at) AS last_sent
             FROM messages
             WHERE device_eui = $1 AND direction = 'downlink'
             GROUP BY fport, command_byte
             ORDER BY count DESC`,
            [devEui],
        );
        res.json(result.rows.map(row => ({
            fport:         row.fport,
            command_byte:  row.command_byte ? `0x${row.command_byte.toUpperCase()}` : null,
            function_name: downlinkFunctionName(row.fport, row.command_byte),
            count:         parseInt(row.count, 10),
            last_sent:     row.last_sent,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Routes — messages
// ---------------------------------------------------------------------------

// GET /api/messages?device_eui=&direction=&from=&to=&limit=&offset=
app.get('/api/messages', async (req, res) => {
    try {
        const params = [];
        const { where } = buildWhereClause(MESSAGE_FILTER_SPEC, req.query, params);
        const { limit, offset } = parsePagination(req.query, { maxLimit: 1000, defaultLimit: 100 });
        await sendPagedList({
            table: 'messages', select: '*',
            orderBy: 'received_at DESC', where, params, limit, offset, res,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Routes — audit log
// ---------------------------------------------------------------------------

// GET /api/audit-log?source=&action=&device_eui=&from=&to=&limit=&offset=
app.get('/api/audit-log', async (req, res) => {
    try {
        const params = [];
        const { where } = buildWhereClause(AUDIT_LOG_FILTER_SPEC, req.query, params);
        const { limit, offset } = parsePagination(req.query, { maxLimit: 1000, defaultLimit: 100 });
        await sendPagedList({
            table: 'audit_log', select: '*',
            orderBy: 'created_at DESC', where, params, limit, offset, res,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Routes — stats
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Routes — demo simulator
// ---------------------------------------------------------------------------

app.post('/api/demo/start', (req, res) => {
    const duration = Math.min(Math.max(parseFloat(req.body.duration) || 5, 1), 30);
    const result = demoSimulator.start(duration);
    if (result.error) return res.status(409).json(result);
    auditLogger.log('demo_simulator', 'demo_start', null, { duration_minutes: duration });
    res.json(result);
});

app.post('/api/demo/stop', (req, res) => {
    const result = demoSimulator.stop();
    if (result.error) return res.status(409).json(result);
    auditLogger.log('demo_simulator', 'demo_stop');
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
        auditLogger.log('demo_simulator', 'demo_reset');
        res.json({ success: true, message: 'All data cleared' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Routes — FUOTA
// ---------------------------------------------------------------------------

app.post('/api/fuota/upload',
    (req, res, next) => {
        upload.single('firmware')(req, res, (err) => {
            if (err?.code === 'LIMIT_FILE_SIZE')
                return res.status(413).json({ error: 'File too large (max 10 MB)' });
            if (err) return res.status(400).json({ error: err.message });
            next();
        });
    },
    async (req, res) => {
        if (!req.file)
            return res.status(400).json({ error: 'No firmware file attached (field name: firmware)' });

        const tmpPath = req.file.path;
        try {
            const name = path.basename(req.file.originalname);
            if (name !== req.file.originalname || !/^[a-zA-Z0-9._\-\s]+$/.test(name) || name.length > 255)
                return res.status(400).json({ error: 'Invalid firmware filename' });

            const buf = await fs.promises.readFile(tmpPath);
            if (buf.length === 0)
                return res.status(400).json({ error: 'Empty firmware file' });

            const result = fuotaManager.storeFirmware(name, buf);
            auditLogger.log('fuota', 'firmware_upload', null, { name, size: buf.length, totalBlocks: result.totalBlocks });
            res.json(result);
        } finally {
            fs.unlink(tmpPath, () => {}); // fire-and-forget temp file cleanup
        }
    }
);

app.post('/api/fuota/start', async (req, res) => {
    const { sessionId, devEuis, blockIntervalMs, ismBand } = req.body;
    if (!sessionId || !Array.isArray(devEuis) || devEuis.length === 0) {
        return res.status(400).json({ error: 'sessionId and devEuis[] are required' });
    }
    const started = [];
    const errors = [];
    for (const devEui of devEuis) {
        try {
            await fuotaManager.startSession(sessionId, devEui, blockIntervalMs, ismBand);
            started.push(devEui);
        } catch (err) {
            errors.push({ devEui, error: err.message });
        }
    }
    auditLogger.log('fuota', 'sessions_start', null, { sessionId, started, errors, blockIntervalMs, ismBand });
    res.json({ started, errors });
});

// GET /api/fuota/sessions?device_eui=&status=
app.get('/api/fuota/sessions', async (req, res) => {
    try {
        const params = [];
        const conditions = [];

        if (req.query.device_eui) {
            params.push(req.query.device_eui);
            conditions.push(`device_eui = $${params.length}`);
        }
        if (req.query.status) {
            params.push(req.query.status);
            conditions.push(`status = $${params.length}`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const dbResult = await pool.query(
            `SELECT id, device_eui, firmware_name, firmware_size, total_blocks,
                    block_interval_ms, status, blocks_sent, verify_attempts,
                    last_missed_blocks, error, started_at, completed_at, updated_at
             FROM fuota_sessions ${where} ORDER BY started_at DESC LIMIT 100`,
            params,
        );
        res.json({
            sessions: dbResult.rows,
            active: fuotaManager.getActiveSessions(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/fuota/abort/:devEui', async (req, res) => {
    const { devEui } = req.params;
    const aborted = await fuotaManager.abortSession(devEui);
    if (!aborted) {
        return res.status(404).json({ error: 'No active FUOTA session for this device' });
    }
    auditLogger.log('fuota', 'session_abort', devEui, {});
    res.json({ aborted: true });
});

app.get('/api/fuota/network-server-status', (req, res) => {
    res.json({ configured: networkClient.configured, type: networkClient.type });
});

app.put('/api/fuota/config', (req, res) => {
    const { maxVerifyRetries } = req.body || {};
    if (!Number.isInteger(maxVerifyRetries) || maxVerifyRetries < 1) {
        return res.status(400).json({ error: 'maxVerifyRetries must be a positive integer' });
    }
    fuotaManager.setVerifyMaxRetries(maxVerifyRetries);
    res.json({ maxVerifyRetries });
});

// PATCH /api/fuota/sessions/:devEui — live block-interval override for an active session.
// Takes effect on the next sleep() iteration; no session abort or restart needed.
app.patch('/api/fuota/sessions/:devEui', (req, res) => {
    const { devEui } = req.params;
    const { blockIntervalMs } = req.body || {};
    if (!Number.isInteger(blockIntervalMs) || blockIntervalMs < 1000) {
        return res.status(400).json({ error: 'blockIntervalMs must be an integer >= 1000' });
    }
    const updated = fuotaManager.updateBlockInterval(devEui, blockIntervalMs);
    if (!updated) return res.status(404).json({ error: 'No active session for this device' });
    res.json({ devEui, blockIntervalMs });
});

// ---------------------------------------------------------------------------
// Routes — API key management
// ---------------------------------------------------------------------------

// POST /api/keys — create a new key; the raw key is returned exactly once.
app.post('/api/keys', async (req, res) => {
    const { label } = req.body;
    if (!label || typeof label !== 'string' || label.trim() === '') {
        return res.status(400).json({ error: 'label is required' });
    }
    if (label.length > 255) {
        return res.status(400).json({ error: 'label must be 255 characters or fewer' });
    }
    try {
        const result = await apiKeyManager.createKey(label.trim());
        auditLogger.log('api_keys', 'key_created', null, { id: result.id, label: result.label });
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/keys — list all keys (no key_hash, no raw key).
app.get('/api/keys', async (req, res) => {
    try {
        const keys = await apiKeyManager.listKeys();
        res.json(keys);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/keys/:id — revoke a key by UUID.
app.delete('/api/keys/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
        return res.status(400).json({ error: 'id must be a valid UUID' });
    }
    try {
        const deleted = await apiKeyManager.revokeKey(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Key not found' });
        auditLogger.log('api_keys', 'key_revoked', null, { id: req.params.id });
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Routes — API documentation
// ---------------------------------------------------------------------------

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customCss: `
    button.copy-to-clipboard {
      color: #9ca3af;
      transition: color 0.15s;
    }
    button.copy-to-clipboard:hover {
      color: #60a5fa;
      background: #3e3e42;
      border-radius: 4px;
    }
    button.copy-to-clipboard.av-copied svg {
      display: none;
    }
    button.copy-to-clipboard.av-copied::after {
      content: '✓';
      color: #22c55e;
      font-size: 14px;
      display: inline-block;
      width: 16px;
      height: 16px;
      line-height: 16px;
      text-align: center;
    }
  `,
  customJsStr: `
    (function () {
      document.addEventListener('click', function (e) {
        var btn = e.target.closest('button.copy-to-clipboard');
        if (!btn) return;
        btn.classList.add('av-copied');
        setTimeout(function () { btn.classList.remove('av-copied'); }, 2000);
      });
    })();
  `,
}));
app.get('/api/openapi.json', (req, res) => res.json(openApiSpec));

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
    log.info('Frontend connected via Socket.io');

    socket.on('publish', (data) => {
        try {
            mqttClient.publish(data.topic, data.payload);
            const devEuiMatch = data.topic.match(/mqtt\/things\/([^/]+)\//);
            auditLogger.log('user', 'downlink_publish', devEuiMatch?.[1] || null, { topic: data.topic, payload: data.payload });
        } catch (e) {
            log.error({ err: e }, 'Publish error');
        }
    });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _decodeFloat32Buffer(buf) {
    const out = [];
    for (let i = 0; i + 3 < buf.length; i += 4) {
        out.push(buf.readFloatLE(i));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { app, server, io };
