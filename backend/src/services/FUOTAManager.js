const { randomUUID } = require('crypto');
const { pool } = require('../db');
const auditLogger = require('./AuditLogger');
const thingParkClient = require('./ThingParkClient');

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 49; // data bytes per block; total downlink = 2-byte LE block_num + 49 bytes = 51 bytes

const FUOTA_BLOCK_INTERVAL_MS = parseInt(process.env.FUOTA_BLOCK_INTERVAL_MS) || 10000;
const FUOTA_ACK_TIMEOUT_MS    = parseInt(process.env.FUOTA_ACK_TIMEOUT_MS)    || 21600000; // 6 hours
const FUOTA_VERIFY_TIMEOUT_MS = parseInt(process.env.FUOTA_VERIFY_TIMEOUT_MS) || 14400000; // 4 hours
const FUOTA_SESSION_TIMEOUT_MS= parseInt(process.env.FUOTA_SESSION_TIMEOUT_MS)|| 93600000; // 26 hours

// Per-session interval clamp bounds (ms)
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60000;

// Firmware store TTL (1 hour) – uploaded binaries are kept in memory this long
const FIRMWARE_STORE_TTL_MS = 3600000;

// ---------------------------------------------------------------------------
// Utility functions (Node.js equivalents of wiki's fuotaPayloads.ts)
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Initialize Upgrade command payload.
 * [0x05, 0x00] + 4-byte Little Endian file size.
 */
function makeInitPayload(size) {
    const buf = Buffer.alloc(6);
    buf[0] = 0x05;
    buf[1] = 0x00;
    buf.writeUInt32LE(size >>> 0, 2);
    return buf;
}

/**
 * Verify Upgrade command payload.
 * [0x06, 0x00]
 */
function makeVerifyPayload() {
    return Buffer.from([0x06, 0x00]);
}

/**
 * Build an Upgrade Data Downlink payload (Port 25).
 * 2-byte LE block number followed by the chunk data.
 */
function makeBlockPayload(blockNum, chunkBuf) {
    const buf = Buffer.alloc(2 + chunkBuf.length);
    buf.writeUInt16LE(blockNum & 0xffff, 0);
    chunkBuf.copy(buf, 2);
    return buf;
}

/**
 * Split a Buffer into an array of CHUNK_SIZE chunks.
 */
function chunkBuffer(buf) {
    const chunks = [];
    for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
        chunks.push(buf.slice(i, Math.min(i + CHUNK_SIZE, buf.length)));
    }
    return chunks;
}

/**
 * Parse a Data Verification Status Uplink (Packet Type 0x11).
 * Returns { ok, missedFlag, count, blocks: number[] } where block numbers are 16-bit LE.
 * Maximum 24 missed block numbers per uplink (EU868/US915 merged payload constraint).
 */
function parseVerifyUplink(buf) {
    if (!buf || buf.length < 3) return { ok: false, reason: 'too_short' };
    if (buf[0] !== 0x11) return { ok: false, reason: 'wrong_type', type: buf[0] };
    const missedFlag = buf[1];
    const count = Math.min(buf[2], 24); // cap at 24 per protocol spec
    const needed = 3 + count * 2;
    if (buf.length < needed) return { ok: false, reason: 'incomplete', count };
    const blocks = [];
    for (let i = 0; i < count; i++) {
        const lo = buf[3 + i * 2];
        const hi = buf[3 + i * 2 + 1];
        blocks.push((lo | (hi << 8)) & 0xffff);
    }
    return { ok: true, missedFlag, count, blocks };
}

// ---------------------------------------------------------------------------
// FUOTAManager
// ---------------------------------------------------------------------------

class FUOTAManager {
    constructor() {
        this.io = null;
        // sessionId → { name, size, blocks: Buffer[], createdAt }
        this.firmwareStore = new Map();
        // devEui → SessionState
        this.activeSessions = new Map();

        this._startCleanupJob();
    }

    /** Must be called once after Socket.io server is created. */
    async init(io) {
        this.io = io;

        // Mark any non-terminal sessions in DB as failed — they were orphaned by the restart
        try {
            const result = await pool.query(
                `UPDATE fuota_sessions
                 SET status='failed', error='Backend restarted during active session',
                     completed_at=NOW(), updated_at=NOW()
                 WHERE status NOT IN ('complete','failed','aborted')
                 RETURNING id, device_eui`
            );
            if (result.rows.length > 0) {
                console.log(`FUOTAManager: marked ${result.rows.length} orphaned session(s) as failed on startup`);
                for (const row of result.rows) {
                    auditLogger.log('fuota_manager', 'startup_cleanup', row.device_eui, { dbId: row.id });
                }
            }
        } catch (err) {
            console.error('FUOTAManager: startup cleanup error:', err.message);
        }
    }

    // -----------------------------------------------------------------------
    // Firmware storage
    // -----------------------------------------------------------------------

    /**
     * Store a decoded firmware binary and return metadata.
     * @param {string} name  Original filename
     * @param {Buffer} buffer  Raw binary
     */
    storeFirmware(name, buffer) {
        const sessionId = randomUUID();
        const blocks = chunkBuffer(buffer);
        this.firmwareStore.set(sessionId, {
            name,
            size: buffer.length,
            blocks,
            createdAt: Date.now(),
        });
        const initPayload = makeInitPayload(buffer.length);
        return {
            sessionId,
            size: buffer.length,
            totalBlocks: blocks.length,
            initPayloadHex: initPayload.toString('hex'),
        };
    }

    // -----------------------------------------------------------------------
    // Session lifecycle
    // -----------------------------------------------------------------------

    /**
     * Start a FUOTA session for a single device.
     * @param {string} sessionId       Firmware store key
     * @param {string} devEui          Target device EUI
     * @param {number} [blockIntervalMs]  Optional per-session interval; clamped to [1000, 60000]
     */
    async startSession(sessionId, devEui, blockIntervalMs) {
        const firmware = this.firmwareStore.get(sessionId);
        if (!firmware) {
            throw new Error(`Firmware session ${sessionId} not found or expired`);
        }

        // Clamp per-session interval
        const intervalMs = (typeof blockIntervalMs === 'number' && isFinite(blockIntervalMs))
            ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(blockIntervalMs)))
            : FUOTA_BLOCK_INTERVAL_MS;

        // If there is already an active session for this device, abort it first
        if (this.activeSessions.has(devEui)) {
            await this._abortSessionInternal(devEui, 'superseded by new session');
        }

        // Create DB record
        let dbId;
        try {
            const res = await pool.query(
                `INSERT INTO fuota_sessions (device_eui, firmware_name, firmware_size, total_blocks, status)
                 VALUES ($1, $2, $3, $4, 'initializing') RETURNING id`,
                [devEui, firmware.name, firmware.size, firmware.blocks.length]
            );
            dbId = res.rows[0].id;
        } catch (err) {
            console.error(`FUOTAManager: DB insert failed for ${devEui}:`, err.message);
            dbId = null;
        }

        const session = {
            sessionId,
            dbId,
            devEui,
            firmwareName: firmware.name,
            firmwareSize: firmware.size,
            blocks: firmware.blocks,
            totalBlocks: firmware.blocks.length,
            blockIntervalMs: intervalMs,
            state: 'initializing',
            blocksSent: 0,
            verifyAttempts: 0,
            lastMissedCount: 0,
            error: null,
            aborted: false,
            // ThingPark Class C state
            classCConfigured: false,
            originalProfileId: null,
            deviceRef: null,
            // Timeout handles
            _ackTimeout: null,
            _verifyTimeout: null,
            _sessionTimeout: null,
            startedAt: Date.now(),
        };

        this.activeSessions.set(devEui, session);

        // Overall session lifetime guard
        session._sessionTimeout = setTimeout(async () => {
            if (this.activeSessions.has(devEui)) {
                await this._failSession(devEui, 'Session exceeded maximum lifetime (26h)');
            }
        }, FUOTA_SESSION_TIMEOUT_MS);

        // Attempt Class C profile switch (non-blocking to session creation)
        const tpResult = await thingParkClient.switchToClassC(devEui);
        session.originalProfileId = tpResult?.originalProfileId || null;
        session.deviceRef = tpResult?.deviceRef || null;
        session.classCConfigured = !!tpResult;

        auditLogger.log('fuota_manager', 'class_c_switch', devEui, {
            success: session.classCConfigured,
            originalProfileId: session.originalProfileId,
            deviceRef: session.deviceRef,
        });

        // Send init downlink then wait for 0x10 ACK
        this._sendInitDownlink(session);
        this._emitProgress(devEui);
        auditLogger.log('fuota_manager', 'session_start', devEui, {
            dbId,
            firmwareName: firmware.name,
            firmwareSize: firmware.size,
            totalBlocks: firmware.blocks.length,
            blockIntervalMs: intervalMs,
        });
    }

    /**
     * Abort an active session (user-triggered).
     */
    async abortSession(devEui) {
        if (!this.activeSessions.has(devEui)) return false;
        await this._abortSessionInternal(devEui, 'user aborted');
        return true;
    }

    // -----------------------------------------------------------------------
    // MQTT uplink handler
    // -----------------------------------------------------------------------

    /**
     * Called for every incoming MQTT message. Filters for FUOTA-relevant packets.
     */
    processPacket(topic, message) {
        try {
            // Extract DevEUI from topic mqtt/things/DEVEUI/uplink
            const parts = topic.split('/');
            if (parts[3] !== 'uplink') return;
            const devEui = parts[2];
            if (!devEui) return;

            // Only care about devices with an active session
            if (!this.activeSessions.has(devEui)) return;

            let buf;
            try {
                const json = JSON.parse(message.toString());
                if (json.DevEUI_uplink && json.DevEUI_uplink.payload_hex) {
                    buf = Buffer.from(json.DevEUI_uplink.payload_hex, 'hex');
                }
            } catch (_) { /* not JSON */ }
            if (!buf) buf = Buffer.isBuffer(message) ? message : Buffer.from(message);

            if (buf.length === 0) return;
            const packetType = buf[0];

            if (packetType === 0x10) {
                this._handleInitAck(devEui, buf);
            } else if (packetType === 0x11) {
                this._handleVerifyUplink(devEui, buf);
            }
        } catch (err) {
            console.error('FUOTAManager.processPacket error:', err.message);
        }
    }

    // -----------------------------------------------------------------------
    // Internal state machine steps
    // -----------------------------------------------------------------------

    _sendInitDownlink(session) {
        const payload = makeInitPayload(session.firmwareSize);
        this._sendDownlink(session.devEui, 22, payload);
        session.state = 'waiting_ack';
        this._updateDb(session);
        this._emitProgress(session.devEui);
        auditLogger.log('fuota_manager', 'init_downlink_sent', session.devEui, {
            firmwareSize: session.firmwareSize,
        });

        // Start ACK timeout
        session._ackTimeout = setTimeout(async () => {
            if (this.activeSessions.get(session.devEui) === session) {
                await this._failSession(session.devEui, `No 0x10 ACK received within ${FUOTA_ACK_TIMEOUT_MS / 3600000}h`);
            }
        }, FUOTA_ACK_TIMEOUT_MS);
    }

    _handleInitAck(devEui, buf) {
        const session = this.activeSessions.get(devEui);
        if (!session || session.state !== 'waiting_ack') return;

        clearTimeout(session._ackTimeout);
        session._ackTimeout = null;

        const errorCode = buf[1] !== undefined ? buf[1] : 0;
        if (errorCode !== 0) {
            this._failSession(devEui, `Init ACK error code: 0x${errorCode.toString(16)}`);
            return;
        }

        console.log(`FUOTAManager: ${devEui} entered Class C (0x10 ACK received)`);
        auditLogger.log('fuota_manager', 'init_ack_received', devEui, { errorCode });
        session.state = 'sending_blocks';
        this._updateDb(session);
        this._emitProgress(devEui);

        // Start sending blocks asynchronously
        this._sendAllBlocks(session).catch(err => {
            console.error(`FUOTAManager: sendAllBlocks error for ${devEui}:`, err.message);
            this._failSession(devEui, err.message);
        });
    }

    async _sendAllBlocks(session) {
        const { devEui, blocks } = session;

        for (let i = 0; i < blocks.length; i++) {
            if (session.aborted) return;
            // Re-check session is still the active one
            if (this.activeSessions.get(devEui) !== session) return;

            const payload = makeBlockPayload(i, blocks[i]);
            this._sendDownlink(devEui, 25, payload);
            session.blocksSent = i + 1;

            // Emit progress every 25 blocks to avoid flooding socket
            if (i % 25 === 0 || i === blocks.length - 1) {
                this._emitProgress(devEui);
            }

            if (i < blocks.length - 1) {
                await sleep(session.blockIntervalMs);
            }
        }

        if (session.aborted) return;
        if (this.activeSessions.get(devEui) !== session) return;

        console.log(`FUOTAManager: ${devEui} all ${blocks.length} blocks sent, sending verify`);
        await this._sendVerify(session);
    }

    async _sendVerify(session) {
        if (session.aborted) return;
        const { devEui } = session;

        session.state = 'verifying';
        session.verifyAttempts += 1;
        this._updateDb(session);
        this._emitProgress(devEui);

        this._sendDownlink(devEui, 22, makeVerifyPayload());
        auditLogger.log('fuota_manager', 'verify_sent', devEui, { attempt: session.verifyAttempts });

        // Timeout waiting for 0x11
        session._verifyTimeout = setTimeout(async () => {
            if (this.activeSessions.get(devEui) === session && session.state === 'verifying') {
                await this._failSession(devEui, `No 0x11 verify response within ${FUOTA_VERIFY_TIMEOUT_MS / 3600000}h`);
            }
        }, FUOTA_VERIFY_TIMEOUT_MS);
    }

    _handleVerifyUplink(devEui, buf) {
        const session = this.activeSessions.get(devEui);
        if (!session) return;
        if (session.state !== 'verifying' && session.state !== 'resending') return;

        clearTimeout(session._verifyTimeout);
        session._verifyTimeout = null;

        const result = parseVerifyUplink(buf);
        if (!result.ok) {
            console.warn(`FUOTAManager: ${devEui} bad 0x11 payload:`, result.reason);
            return;
        }

        auditLogger.log('fuota_manager', 'verify_uplink_received', devEui, {
            missedFlag: result.missedFlag,
            missedCount: result.count,
            blocks: result.blocks,
        });

        if (result.missedFlag === 0 && result.count === 0) {
            // All blocks received — device is applying the update
            this._completeSession(devEui);
        } else {
            // Resend missed blocks then verify again
            session.state = 'resending';
            session.lastMissedCount = result.count;
            this._updateDb(session);
            this._emitProgress(devEui);

            this._resendMissedBlocks(session, result.blocks).catch(err => {
                console.error(`FUOTAManager: resend error for ${devEui}:`, err.message);
                this._failSession(devEui, err.message);
            });
        }
    }

    async _resendMissedBlocks(session, missedBlockNums) {
        const { devEui, blocks } = session;
        console.log(`FUOTAManager: ${devEui} resending ${missedBlockNums.length} missed blocks:`, missedBlockNums);

        for (let i = 0; i < missedBlockNums.length; i++) {
            if (session.aborted) return;
            if (this.activeSessions.get(devEui) !== session) return;

            const blockNum = missedBlockNums[i];
            if (blockNum >= blocks.length) {
                console.warn(`FUOTAManager: ${devEui} missed block ${blockNum} out of range (total ${blocks.length})`);
                continue;
            }
            const payload = makeBlockPayload(blockNum, blocks[blockNum]);
            this._sendDownlink(devEui, 25, payload);

            if (i < missedBlockNums.length - 1) {
                await sleep(session.blockIntervalMs);
            }
        }

        if (session.aborted) return;
        if (this.activeSessions.get(devEui) !== session) return;

        await this._sendVerify(session);
    }

    // -----------------------------------------------------------------------
    // Terminal states
    // -----------------------------------------------------------------------

    async _completeSession(devEui) {
        const session = this.activeSessions.get(devEui);
        if (!session) return;

        this._clearTimeouts(session);
        session.state = 'complete';
        session.error = null;

        await this._updateDb(session, true);
        this._emitProgress(devEui);
        this.activeSessions.delete(devEui);

        console.log(`FUOTAManager: ${devEui} FUOTA complete after ${session.verifyAttempts} verify attempt(s)`);
        auditLogger.log('fuota_manager', 'session_complete', devEui, {
            verifyAttempts: session.verifyAttempts,
            totalBlocks: session.totalBlocks,
        });

        // Restore Class A profile
        if (session.originalProfileId && session.deviceRef) {
            await thingParkClient.restoreClass(devEui, session.originalProfileId, session.deviceRef);
            auditLogger.log('fuota_manager', 'class_a_restore', devEui, { profileId: session.originalProfileId });
        }
    }

    async _failSession(devEui, reason) {
        const session = this.activeSessions.get(devEui);
        if (!session) return;

        this._clearTimeouts(session);
        session.state = 'failed';
        session.error = reason;
        session.aborted = true;

        await this._updateDb(session, true);
        this._emitProgress(devEui);
        this.activeSessions.delete(devEui);

        console.error(`FUOTAManager: ${devEui} session failed: ${reason}`);
        auditLogger.log('fuota_manager', 'session_failed', devEui, { reason });

        // Restore Class A profile
        if (session.originalProfileId && session.deviceRef) {
            await thingParkClient.restoreClass(devEui, session.originalProfileId, session.deviceRef);
            auditLogger.log('fuota_manager', 'class_a_restore', devEui, { profileId: session.originalProfileId });
        }
    }

    async _abortSessionInternal(devEui, reason) {
        const session = this.activeSessions.get(devEui);
        if (!session) return;

        this._clearTimeouts(session);
        session.state = 'aborted';
        session.error = reason;
        session.aborted = true;

        await this._updateDb(session, true);
        this._emitProgress(devEui);
        this.activeSessions.delete(devEui);

        console.log(`FUOTAManager: ${devEui} session aborted: ${reason}`);
        auditLogger.log('fuota_manager', 'session_aborted', devEui, { reason });

        // Restore Class A profile
        if (session.originalProfileId && session.deviceRef) {
            await thingParkClient.restoreClass(devEui, session.originalProfileId, session.deviceRef);
            auditLogger.log('fuota_manager', 'class_a_restore', devEui, { profileId: session.originalProfileId });
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    _clearTimeouts(session) {
        clearTimeout(session._ackTimeout);
        clearTimeout(session._verifyTimeout);
        clearTimeout(session._sessionTimeout);
        session._ackTimeout = null;
        session._verifyTimeout = null;
        session._sessionTimeout = null;
    }

    _sendDownlink(devEui, port, payloadBuf) {
        const topic = `mqtt/things/${devEui}/downlink`;
        const message = JSON.stringify({
            DevEUI_downlink: {
                DevEUI: devEui,
                FPort: port,
                payload_hex: payloadBuf.toString('hex'),
            },
        });
        // Lazy load to avoid circular dependency
        const mqttClient = require('../mqttClient');
        mqttClient.publish(topic, message);
    }

    _emitProgress(devEui) {
        if (!this.io) return;
        const session = this.activeSessions.get(devEui);
        const payload = session
            ? {
                  devEui,
                  state: session.state,
                  blocksSent: session.blocksSent,
                  totalBlocks: session.totalBlocks,
                  verifyAttempts: session.verifyAttempts,
                  lastMissedCount: session.lastMissedCount,
                  error: session.error,
                  firmwareName: session.firmwareName,
                  firmwareSize: session.firmwareSize,
                  blockIntervalMs: session.blockIntervalMs,
                  classCConfigured: session.classCConfigured,
              }
            : { devEui, state: 'idle' };
        this.io.emit('fuota:progress', payload);
    }

    async _updateDb(session, isFinal = false) {
        if (!session.dbId) return;
        try {
            await pool.query(
                `UPDATE fuota_sessions
                 SET status = $1, blocks_sent = $2, verify_attempts = $3,
                     last_missed_blocks = $4, error = $5,
                     completed_at = $6, updated_at = NOW()
                 WHERE id = $7`,
                [
                    session.state,
                    session.blocksSent,
                    session.verifyAttempts,
                    JSON.stringify([]),   // cleared after each resend cycle
                    session.error,
                    isFinal ? new Date() : null,
                    session.dbId,
                ]
            );
        } catch (err) {
            console.error('FUOTAManager: DB update error:', err.message);
        }
    }

    /** Return a snapshot of all active sessions (for REST status endpoint). */
    getActiveSessions() {
        const out = [];
        for (const [devEui, s] of this.activeSessions) {
            out.push({
                devEui,
                state: s.state,
                firmwareName: s.firmwareName,
                firmwareSize: s.firmwareSize,
                blocksSent: s.blocksSent,
                totalBlocks: s.totalBlocks,
                verifyAttempts: s.verifyAttempts,
                lastMissedCount: s.lastMissedCount,
                error: s.error,
                blockIntervalMs: s.blockIntervalMs,
                classCConfigured: s.classCConfigured,
                startedAt: new Date(s.startedAt).toISOString(),
            });
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Housekeeping
    // -----------------------------------------------------------------------

    _startCleanupJob() {
        // Purge expired firmware store entries every 15 minutes
        setInterval(() => {
            const now = Date.now();
            for (const [id, fw] of this.firmwareStore) {
                if (now - fw.createdAt > FIRMWARE_STORE_TTL_MS) {
                    this.firmwareStore.delete(id);
                    console.log(`FUOTAManager: evicted firmware store entry ${id}`);
                }
            }
        }, 15 * 60 * 1000);
    }
}

module.exports = new FUOTAManager();
