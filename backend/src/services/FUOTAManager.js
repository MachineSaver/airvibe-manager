const { randomUUID } = require('crypto');
const { pool } = require('../db');
const auditLogger = require('./AuditLogger');
const networkClient = require('./networkServerClient');
const log = require('../logger').child({ module: 'FUOTAManager' });

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 49; // data bytes per block; total downlink = 2-byte LE block_num + 49 bytes = 51 bytes

const FUOTA_BLOCK_INTERVAL_MS = parseInt(process.env.FUOTA_BLOCK_INTERVAL_MS) || 10000;
const FUOTA_VERIFY_TIMEOUT_MS = parseInt(process.env.FUOTA_VERIFY_TIMEOUT_MS) || 14400000; // 4 hours
const FUOTA_SESSION_TIMEOUT_MS= parseInt(process.env.FUOTA_SESSION_TIMEOUT_MS)|| 432000000; // 120 hours (5 days)

// Per-session interval clamp bounds (ms).
const INTERVAL_LIMITS = {
    US915:    { min:  5_000, max: 180_000 },
    EU868:    { min:  5_000, max: 180_000 },
    TPM_EU868:{ min: 60_000, max: 180_000 }, // Class A only — slower cadence for ETSI duty-cycle
};
const DEFAULT_INTERVAL_LIMITS = { min: 5_000, max: 180_000 };

/**
 * Returns true when a firmware update must run in Class A mode (no Class C switch).
 * Currently: any TPM firmware targeting EU868.
 * @param {string|null|undefined} firmwareName
 * @param {string|null|undefined} ismBand
 */
function isClassAOnly(firmwareName, ismBand) {
    const name = (firmwareName || '').toUpperCase();
    const band = (ismBand     || '').toUpperCase();
    const isTpm  = name.includes('TPM');
    const isEu868 = band.includes('868') || name.includes('868');
    return isTpm && isEu868;
}

/**
 * Resolve min/max interval bounds for a session.
 * Priority: TPM EU868 special case > ismBand > infer from firmware filename > fallback.
 * @param {string|null|undefined} ismBand
 * @param {string|null|undefined} firmwareName
 * @returns {{ min: number, max: number }}
 */
function resolveIntervalLimits(ismBand, firmwareName) {
    if (isClassAOnly(firmwareName, ismBand)) return INTERVAL_LIMITS.TPM_EU868;
    const band = ismBand || '';
    if (band.includes('915')) return INTERVAL_LIMITS.US915;
    if (band.includes('868')) return INTERVAL_LIMITS.EU868;
    const name = firmwareName || '';
    if (name.includes('915')) return INTERVAL_LIMITS.US915;
    if (name.includes('868')) return INTERVAL_LIMITS.EU868;
    return DEFAULT_INTERVAL_LIMITS;
}

// Init downlink retry schedule.
// If no 0x10 ACK is received within the timeout for each attempt, the init
// downlink is re-sent up to ACK_MAX_ATTEMPTS times before the session fails.
//   Tier 1: 5 attempts × 1 min   (covers brief delivery failures / Basic Station queue)
//   Tier 2: 5 attempts × 5 min   (covers longer radio gaps)
//   Tier 3: 3 attempts × 10 min  (last resort before giving up)
// Total: 13 attempts, ~60 minutes of patience.
const ACK_RETRY_SCHEDULE = [
    { attempts: 5, intervalMs:    60_000 },  // 5 × 1 min
    { attempts: 5, intervalMs:   300_000 },  // 5 × 5 min
    { attempts: 3, intervalMs:   600_000 },  // 3 × 10 min
];
const ACK_MAX_ATTEMPTS = ACK_RETRY_SCHEDULE.reduce((s, r) => s + r.attempts, 0); // 13

/**
 * Return the ACK timeout duration for a given init attempt number (1-based).
 * Walks the schedule tiers and returns the interval for the tier the attempt falls in.
 */
function initAckWaitMs(attemptNumber) {
    let remaining = attemptNumber;
    for (const { attempts, intervalMs } of ACK_RETRY_SCHEDULE) {
        if (remaining <= attempts) return intervalMs;
        remaining -= attempts;
    }
    return ACK_RETRY_SCHEDULE[ACK_RETRY_SCHEDULE.length - 1].intervalMs;
}

// Verify retry settings.
// First verify attempt is sent after FUOTA_VERIFY_PRE_DELAY_MS to let the device
// finish processing the last data block before checking receipt.
// On no-response, retries up to FUOTA_VERIFY_MAX_RETRIES times (total), dividing
// FUOTA_VERIFY_TIMEOUT_MS evenly across attempts.
const FUOTA_VERIFY_MAX_RETRIES  = parseInt(process.env.FUOTA_VERIFY_MAX_RETRIES)  || 10;
const FUOTA_VERIFY_PRE_DELAY_MS    = parseInt(process.env.FUOTA_VERIFY_PRE_DELAY_MS)    || 30000;  // 30 s
// After all blocks are confirmed (empty 0x11), the device writes to flash and
// then reboots before sending 0x12.  EU868 TPM flash takes ~2-3 min, but the
// 0x12 uplink must propagate back through the LoRaWAN network after the device
// reboots, which can add several minutes (especially if Class A restore has
// already fired).  20 min gives a very generous safety margin.
const FUOTA_FLASH_TIMEOUT_MS = parseInt(process.env.FUOTA_FLASH_TIMEOUT_MS) || 20 * 60 * 1000; // 20 min
// After resending a missed-block batch, wait this long before issuing the next
// 0x0600 verify command so the device has time to finish writing the blocks to
// flash before it checks receipt (default 30 s).
const FUOTA_RESEND_VERIFY_DELAY_MS = parseInt(process.env.FUOTA_RESEND_VERIFY_DELAY_MS) || 30000;  // 30 s

// Firmware store TTL (1 hour) – uploaded binaries are kept in memory this long
const FIRMWARE_STORE_TTL_MS = 3600000;

// Config pre-flight poll.
// Before switching to Class C and sending the init downlink, check whether the device's
// config_updated_at (written by MessageTracker on every 0x02 config uplink) is fresh enough.
// If it is older than CONFIG_FRESH_MS (default 6h) or absent, send up to CONFIG_POLL_MAX
// confirmed 0x0200 config requests, waiting CONFIG_POLL_WAIT_MS between each attempt.
// If the device responds at any point the poll exits early; after CONFIG_POLL_MAX attempts
// FUOTA proceeds regardless so the user is never permanently blocked.
const CONFIG_FRESH_MS    = parseInt(process.env.FUOTA_CONFIG_FRESH_MS)    || 6 * 60 * 60 * 1000; // 6h
const CONFIG_POLL_WAIT_MS = parseInt(process.env.FUOTA_CONFIG_POLL_WAIT_MS) || 5 * 60 * 1000;     // 5 min
const CONFIG_POLL_MAX    = 3;

// ---------------------------------------------------------------------------
// ISM band → ThingPark Class C device profile mapping
// ---------------------------------------------------------------------------
// Derived automatically from the Frequency field in each uplink envelope
// (written to devices.metadata.ism_band by MessageTracker).
// ETSI regulatory domain: EU868, EU433
// FCC  regulatory domain: US915, AU915, CN470
const BAND_TO_CLASS_C_PROFILE = {
    EU868: 'LORA/GenericC.1.0.4a_ETSI',
    EU433: 'LORA/GenericC.1.0.4a_ETSI',
    US915: 'LORA/GenericC.1.0.4a_FCC',
    AU915: 'LORA/GenericC.1.0.4a_FCC',
    CN470: 'LORA/GenericC.1.0.4a_FCC',
};

/**
 * Return the ThingPark Class C profile for a known ISM band, or null if unknown.
 * Null causes ThingParkClient to fall back to its THINGPARK_CLASS_C_PROFILE env var.
 */
function ismBandToClassCProfile(ismBand) {
    return BAND_TO_CLASS_C_PROFILE[ismBand] || null;
}

/**
 * Resolve the ThingPark Class C profile for a device.
 *
 * Priority:
 *   1. devices.metadata.ism_band  — auto-detected from uplink Frequency by MessageTracker
 *   2. ismBandFallback             — user-selected in the FUOTA Manager UI (sent with start request)
 *   3. null                        — no profile known; ThingParkClient will warn and skip Class C switch
 *
 * @param {string} devEui
 * @param {string} [ismBandFallback]  Band selected by the user in the UI (e.g. 'EU868', 'US915')
 */
async function resolveClassCProfile(devEui, ismBandFallback) {
    // 1. Auto-detected from uplink Frequency (most reliable)
    try {
        const row = await pool.query(
            `SELECT metadata->>'ism_band' AS ism_band FROM devices WHERE dev_eui = $1`,
            [devEui]
        );
        const ismBand = row.rows[0]?.ism_band;
        if (ismBand) {
            const profile = ismBandToClassCProfile(ismBand);
            if (profile) {
                log.info(`FUOTAManager: ${devEui} ISM band=${ismBand} (auto-detected) → ${profile}`);
            }
            return profile;
        }
    } catch (err) {
        log.warn(`FUOTAManager: could not resolve ISM band for ${devEui}: ${err.message}`);
    }

    // 2. User-selected band from the FUOTA UI start request
    if (ismBandFallback) {
        const profile = ismBandToClassCProfile(ismBandFallback);
        if (profile) {
            log.info(`FUOTAManager: ${devEui} ISM band=${ismBandFallback} (user-selected) → ${profile}`);
        } else {
            log.warn(`FUOTAManager: ${devEui} unrecognised ISM band '${ismBandFallback}'`);
        }
        return profile;
    }

    // 3. No known band — Class C switch will be skipped with a warning
    log.warn(
        `FUOTAManager: ${devEui} has no known ISM band and none was selected in the UI. ` +
        `Class C switch will be skipped; FUOTA will proceed in Class A mode.`
    );
    return null;
}

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
        // Mutable cap; defaults to the env var, can be updated live via setVerifyMaxRetries()
        this._verifyMaxRetries = FUOTA_VERIFY_MAX_RETRIES;

        this._startCleanupJob();
    }

    /**
     * Update the maximum number of verify attempts for all subsequent verify
     * commands (including any session currently in the verify/resend cycle).
     * @param {number} n  Must be a positive integer.
     */
    setVerifyMaxRetries(n) {
        this._verifyMaxRetries = n;
    }

    /** Must be called once after Socket.io server is created. */
    async init(io) {
        this.io = io;

        // Recover any sessions that were active when the backend last restarted.
        // Sessions with a persisted firmware binary are resumed from block 0 (safe because
        // the AirVibe device tolerates duplicate block reception; the verify loop handles gaps).
        // Sessions without firmware_data (created before this feature was added) are failed.
        try {
            const orphans = await pool.query(
                `SELECT id, device_eui, firmware_name, firmware_size, total_blocks,
                        block_interval_ms, blocks_sent, verify_attempts, firmware_data,
                        original_class_info
                 FROM fuota_sessions
                 WHERE status NOT IN ('complete','failed','aborted')`
            );

            let recovered = 0;
            let failed = 0;

            for (const row of orphans.rows) {
                const devEui = row.device_eui;

                if (!row.firmware_data) {
                    // Pre-persistence session — no binary, cannot recover
                    await pool.query(
                        `UPDATE fuota_sessions
                         SET status='failed', error='Backend restarted — no firmware binary available for recovery',
                             completed_at=NOW(), updated_at=NOW()
                         WHERE id=$1`,
                        [row.id]
                    );
                    auditLogger.log('fuota_manager', 'startup_cleanup', devEui, { dbId: row.id, reason: 'no_firmware_data' });
                    failed++;
                    continue;
                }

                const rawBuffer = Buffer.from(row.firmware_data);
                const blocks = chunkBuffer(rawBuffer);
                const intervalMs = row.block_interval_ms || FUOTA_BLOCK_INTERVAL_MS;

                const session = {
                    sessionId:       null,   // no in-memory firmware store entry for recovered sessions
                    dbId:            row.id,
                    devEui,
                    firmwareName:    row.firmware_name,
                    firmwareSize:    row.firmware_size,
                    blocks,
                    totalBlocks:     row.total_blocks,
                    blockIntervalMs: intervalMs,
                    state:           'initializing',
                    blocksSent:      row.blocks_sent || 0,
                    blocksSentAtStart: row.blocks_sent || 0,
                    blocksResentSoFar: 0,
                    confirmedBlocks: new Set(),
                    verifyAttempts:  row.verify_attempts || 0,
                    lastMissedCount: 0,
                    lastMissedBlocks:[],
                    error:           null,
                    aborted:         false,
                    configCheckDone: true,   // recovery skips _prefillConfig
                    classCConfigured:false,
                    originalClass:   null,
                    _ackTimeout:     null,
                    _verifyTimeout:  null,
                    _sessionTimeout: null,
                    startedAt:       Date.now(),
                };

                this.activeSessions.set(devEui, session);

                session._sessionTimeout = setTimeout(async () => {
                    if (this.activeSessions.has(devEui)) {
                        await this._failSession(devEui, `Session exceeded maximum lifetime (${FUOTA_SESSION_TIMEOUT_MS / 3600000}h)`);
                    }
                }, FUOTA_SESSION_TIMEOUT_MS);

                // Per-session try-catch: one session failing must not abort recovery of others.
                try {
                    // Use the original class info persisted at session start so the correct
                    // Class A profile is restored after FUOTA completes.
                    if (row.original_class_info) {
                        session.originalClass    = row.original_class_info;
                        session.classCConfigured = true;
                        log.info(`FUOTAManager: ${devEui} recovery — restored original class info from DB`);
                    }

                    // Wait for MQTT before starting block send — the broker may not be
                    // connected yet if the backend restarted while MQTT was still connecting.
                    await this._waitForMqtt(devEui);

                    // Skip the init downlink on recovery. The device was already initialised
                    // in the prior session (and may be in Class C mid-FUOTA). Re-sending the
                    // init could reset its block-tracking state. Go straight to block 0 —
                    // duplicates are safe and the verify phase handles any gaps.
                    session.state = 'sending_blocks';
                    this._updateDb(session);
                    this._emitProgress(devEui);
                    auditLogger.log('fuota_manager', 'session_resumed', devEui, {
                        dbId: row.id,
                        totalBlocks: row.total_blocks,
                        blockIntervalMs: intervalMs,
                        classCConfigured: session.classCConfigured,
                    });
                    log.info(`FUOTAManager: recovered session for ${devEui} (${row.firmware_name}, ${row.total_blocks} blocks)`);
                    this._sendAllBlocks(session).catch(err => {
                        if (this.activeSessions.get(devEui) === session) {
                            this._failSession(devEui, err.message);
                        }
                    });
                    recovered++;
                } catch (sessionErr) {
                    log.error(`FUOTAManager: startup recovery failed for ${devEui}: ${sessionErr.message}`);
                    clearTimeout(session._sessionTimeout);
                    session._sessionTimeout = null;
                    this.activeSessions.delete(devEui);
                }
            }

            if (recovered > 0 || failed > 0) {
                log.info(`FUOTAManager: startup recovery — ${recovered} resumed, ${failed} failed (no binary)`);
            }
        } catch (err) {
            log.error(`FUOTAManager: startup recovery error: ${err.message}`);
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
            rawBuffer: buffer,   // retained so startSession() can persist it to DB
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
     * @param {string} sessionId         Firmware store key
     * @param {string} devEui            Target device EUI
     * @param {number} [blockIntervalMs] Optional per-session interval; clamped to [MIN, MAX]
     * @param {string} [ismBand]         ISM band selected in UI ('EU868', 'US915', etc.)
     *   Used as fallback when devices.metadata.ism_band is not yet populated.
     */
    async startSession(sessionId, devEui, blockIntervalMs, ismBand) {
        const firmware = this.firmwareStore.get(sessionId);
        if (!firmware) {
            throw new Error(`Firmware session ${sessionId} not found or expired`);
        }

        // Clamp per-session interval to band-specific bounds.
        const limits = resolveIntervalLimits(ismBand, firmware.name);
        const intervalMs = (typeof blockIntervalMs === 'number' && isFinite(blockIntervalMs))
            ? Math.min(limits.max, Math.max(limits.min, Math.round(blockIntervalMs)))
            : Math.min(limits.max, Math.max(limits.min, FUOTA_BLOCK_INTERVAL_MS));

        // If there is already an active session for this device, abort it first
        if (this.activeSessions.has(devEui)) {
            await this._abortSessionInternal(devEui, 'superseded by new session');
        }

        // Ensure a devices row exists so the FK on fuota_sessions is satisfied.
        // Devices that haven't sent an uplink yet get a placeholder row; MessageTracker
        // will backfill last_seen, uplink_count, and metadata on first uplink.
        await pool.query(
            `INSERT INTO devices (dev_eui) VALUES ($1) ON CONFLICT (dev_eui) DO NOTHING`,
            [devEui]
        );

        // Create DB record and persist firmware binary for restart recovery
        let dbId;
        try {
            const res = await pool.query(
                `INSERT INTO fuota_sessions
                     (device_eui, firmware_name, firmware_size, total_blocks, block_interval_ms, status)
                 VALUES ($1, $2, $3, $4, $5, 'initializing') RETURNING id`,
                [devEui, firmware.name, firmware.size, firmware.blocks.length, intervalMs]
            );
            dbId = res.rows[0].id;
            // Persist the raw binary so the session can be recovered after a backend restart.
            // Stored as BYTEA; Postgres TOAST-compresses values > ~2KB automatically.
            // Cleared to NULL when the session reaches a terminal state.
            await pool.query(
                `UPDATE fuota_sessions SET firmware_data = $1 WHERE id = $2`,
                [firmware.rawBuffer, dbId]
            );
        } catch (err) {
            log.error(`FUOTAManager: DB insert failed for ${devEui}: ${err.message}`);
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
            blocksSentAtStart: 0,
            blocksResentSoFar: 0,
            confirmedBlocks: new Set(),
            configCheckDone: false,
            classAOnly: false,
            configPollAttempt: 0,
            initAttempts: 0,
            verifyAttempts: 0,
            lastMissedCount: 0,
            lastMissedBlocks: [],
            error: null,
            aborted: false,
            // ChirpStack Class C state
            classCConfigured: false,
            originalClass: null,
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
                await this._failSession(devEui, `Session exceeded maximum lifetime (${FUOTA_SESSION_TIMEOUT_MS / 3600000}h)`);
            }
        }, FUOTA_SESSION_TIMEOUT_MS);

        // Pre-flight: ensure device has a fresh config before starting FUOTA.
        // Sends up to CONFIG_POLL_MAX confirmed 0x0200 requests if config is stale/absent.
        await this._prefillConfig(devEui);

        // Guard: session may have been aborted or superseded during config poll
        if (!this.activeSessions.has(devEui) || session.aborted) return;

        // Mark config check as complete and notify the frontend so it never
        // shows Config ✓ before _prefillConfig has actually run.
        session.configCheckDone = true;
        this._emitProgress(devEui);

        // Determine whether this firmware update must stay in Class A mode.
        // EU868 TPM updates do not require a Class C profile switch — the device receives
        // blocks in its normal Class A RX windows at a slower cadence (60–180 s).
        session.classAOnly = isClassAOnly(firmware.name, ismBand);

        if (session.classAOnly) {
            log.info(
                `FUOTAManager: ${devEui} EU868 TPM firmware — proceeding in Class A mode ` +
                `(no Class C switch; block interval ${session.blockIntervalMs} ms)`
            );
            auditLogger.log('fuota_manager', 'class_a_only', devEui, { firmwareName: firmware.name });
        } else {
            // Resolve per-device Class C profile: auto-detected band first, then user selection.
            const classCProfile = await resolveClassCProfile(devEui, ismBand);

            // Attempt Class C switch via the active network server client.
            const csResult = await networkClient.switchToClassC(devEui, classCProfile);
            session.originalClass    = csResult?.originalClass || null;
            session.classCConfigured = !!csResult;

            // Persist the original class info to DB so a backend restart can restore it.
            if (session.originalClass && dbId) {
                try {
                    await pool.query(
                        `UPDATE fuota_sessions SET original_class_info = $1 WHERE id = $2`,
                        [JSON.stringify(session.originalClass), dbId]
                    );
                } catch (err) {
                    log.warn(`FUOTAManager: could not persist original_class_info for ${devEui}: ${err.message}`);
                }
            }

            auditLogger.log('fuota_manager', 'class_c_switch', devEui, {
                success: session.classCConfigured,
                originalClass: session.originalClass,
            });

            if (!session.classCConfigured) {
                log.warn(
                    `FUOTAManager: ${devEui} Class C switch failed — proceeding in Class A mode. ` +
                    `ThingPark/Basic Station queues only 1–2 downlinks per device; at the default ` +
                    `10 s block interval the queue will overflow immediately. ` +
                    `Set FUOTA_BLOCK_INTERVAL_MS=120000 (or higher) in .env for Class A, ` +
                    `or fix Class C switching via THINGPARK_CLASS_C_PROFILE and credentials.`
                );
            }
        }

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
            } else if (packetType === 0x12) {
                this._handleFlashStatus(devEui, buf);
            }
        } catch (err) {
            log.error(`FUOTAManager.processPacket error: ${err.message}`);
        }
    }

    // -----------------------------------------------------------------------
    // Internal state machine steps
    // -----------------------------------------------------------------------

    _sendInitDownlink(session) {
        // If a 0x10 ACK arrived early (while session was still 'initializing' or
        // 'config_poll'), the device already processed a prior init downlink and is
        // ready to receive blocks.  Skip the re-send and consume the stashed ACK.
        if (session._earlyInitAck) {
            const earlyBuf = session._earlyInitAck;
            session._earlyInitAck = null;
            log.info(`FUOTAManager: ${session.devEui} consuming stashed early 0x10 ACK — skipping init downlink`);
            auditLogger.log('fuota_manager', 'init_ack_early', session.devEui, {});
            session.state = 'waiting_ack'; // satisfy _handleInitAck's state guard
            this._handleInitAck(session.devEui, earlyBuf);
            return;
        }

        session.initAttempts = (session.initAttempts || 0) + 1;

        const payload = makeInitPayload(session.firmwareSize);
        this._sendDownlink(session.devEui, 22, payload, true);
        session.state = 'waiting_ack';
        this._updateDb(session);
        this._emitProgress(session.devEui);
        auditLogger.log('fuota_manager', 'init_downlink_sent', session.devEui, {
            firmwareSize: session.firmwareSize,
            attempt: session.initAttempts,
        });

        // Per-attempt timeout: re-send if retries remain, fail once budget exhausted.
        const waitMs = initAckWaitMs(session.initAttempts);
        session._ackTimeout = setTimeout(async () => {
            if (this.activeSessions.get(session.devEui) !== session) return;
            if (session.state !== 'waiting_ack') return;

            if (session.initAttempts < ACK_MAX_ATTEMPTS) {
                log.warn(
                    `FUOTAManager: ${session.devEui} no 0x10 ACK ` +
                    `(attempt ${session.initAttempts}/${ACK_MAX_ATTEMPTS}) — retrying init downlink`
                );
                auditLogger.log('fuota_manager', 'init_ack_timeout_retry', session.devEui, {
                    attempt: session.initAttempts,
                });
                clearTimeout(session._ackTimeout);
                session._ackTimeout = null;
                this._sendInitDownlink(session);
            } else {
                await this._failSession(
                    session.devEui,
                    `No 0x10 ACK after ${ACK_MAX_ATTEMPTS} attempts (5×1 min, 5×5 min, 3×10 min)`
                );
            }
        }, waitMs);
    }

    _handleInitAck(devEui, buf) {
        const session = this.activeSessions.get(devEui);
        if (!session) return;

        // If the ACK arrived before pre-flight or Class C switch completed, stash it.
        // _sendInitDownlink will consume it and skip the redundant re-send.
        if (session.state === 'initializing' || session.state === 'config_poll') {
            session._earlyInitAck = buf;
            log.info(`FUOTAManager: ${devEui} early 0x10 ACK received during '${session.state}' — stashed`);
            return;
        }

        if (session.state !== 'waiting_ack') return;

        clearTimeout(session._ackTimeout);
        session._ackTimeout = null;

        const errorCode = buf[1] !== undefined ? buf[1] : 0;
        if (errorCode !== 0) {
            this._failSession(devEui, `Init ACK error code: 0x${errorCode.toString(16)}`);
            return;
        }

        log.info(`FUOTAManager: ${devEui} entered Class C (0x10 ACK received)`);
        auditLogger.log('fuota_manager', 'init_ack_received', devEui, { errorCode });

        session.state = 'sending_blocks';
        this._updateDb(session);
        this._emitProgress(devEui);

        // Start sending blocks asynchronously
        this._sendAllBlocks(session).catch(err => {
            log.error(`FUOTAManager: sendAllBlocks error for ${devEui}: ${err.message}`);
            this._failSession(devEui, err.message);
        });
    }

    async _sendAllBlocks(session) {
        const { devEui, blocks } = session;

        for (let i = session.blocksSent; i < blocks.length; i++) {
            if (session.aborted) return;
            // Re-check session is still the active one
            if (this.activeSessions.get(devEui) !== session) return;

            // Pause if broker is disconnected; throws after timeout → _failSession
            await this._waitForMqtt(devEui);
            if (session.aborted || this.activeSessions.get(devEui) !== session) return;

            const payload = makeBlockPayload(i, blocks[i]);
            this._sendDownlink(devEui, 25, payload, true);
            session.blocksSent = i + 1;

            // Emit progress every 5 blocks for near-real-time UI updates
            if (i % 5 === 0 || i === blocks.length - 1) {
                this._emitProgress(devEui);
            }

            // Flush blocks_sent to DB every 100 blocks so Session History stays current
            if (session.blocksSent % 100 === 0) {
                this._updateDb(session).catch(() => {});
            }

            if (i < blocks.length - 1) {
                await sleep(session.blockIntervalMs);
            }
        }

        if (session.aborted) return;
        if (this.activeSessions.get(devEui) !== session) return;

        log.info(`FUOTAManager: ${devEui} all ${blocks.length} blocks sent, sending verify`);
        await this._sendVerify(session);
    }

    async _sendVerify(session) {
        if (session.aborted) return;
        const { devEui } = session;

        // On the very first verify attempt, wait briefly so the device finishes
        // processing the final data block before receiving the verify command.
        if (session.verifyAttempts === 0) {
            await sleep(FUOTA_VERIFY_PRE_DELAY_MS);
            if (session.aborted || this.activeSessions.get(devEui) !== session) return;
        }

        session.state = 'verifying';
        session.verifyAttempts += 1;
        this._updateDb(session);
        this._emitProgress(devEui);

        this._sendDownlink(devEui, 22, makeVerifyPayload(), true);
        auditLogger.log('fuota_manager', 'verify_sent', devEui, { attempt: session.verifyAttempts });

        // Each attempt gets an equal share of the total verify timeout budget.
        // On timeout: retry if attempts remain, otherwise fail the session.
        const maxRetries = this._verifyMaxRetries;
        const attemptMs = Math.floor(FUOTA_VERIFY_TIMEOUT_MS / maxRetries);
        session._verifyTimeout = setTimeout(async () => {
            if (this.activeSessions.get(devEui) !== session || session.state !== 'verifying') return;

            if (session.verifyAttempts < maxRetries) {
                log.warn(
                    `FUOTAManager: ${devEui} no 0x11 response ` +
                    `(attempt ${session.verifyAttempts}/${maxRetries}), retrying verify…`
                );
                auditLogger.log('fuota_manager', 'verify_timeout_retry', devEui, {
                    attempt: session.verifyAttempts,
                });
                clearTimeout(session._verifyTimeout);
                session._verifyTimeout = null;
                await this._sendVerify(session);
            } else {
                await this._failSession(devEui,
                    `No 0x11 verify response after ${maxRetries} attempts ` +
                    `(${FUOTA_VERIFY_TIMEOUT_MS / 3600000}h total)`
                );
            }
        }, attemptMs);
    }

    _handleVerifyUplink(devEui, buf) {
        const session = this.activeSessions.get(devEui);
        if (!session) return;
        if (session.state !== 'verifying') return;

        clearTimeout(session._verifyTimeout);
        session._verifyTimeout = null;

        const result = parseVerifyUplink(buf);
        if (!result.ok) {
            log.warn(`FUOTAManager: ${devEui} bad 0x11 payload: ${result.reason}`);
            return;
        }

        auditLogger.log('fuota_manager', 'verify_uplink_received', devEui, {
            missedFlag: result.missedFlag,
            missedCount: result.count,
            blocks: result.blocks,
        });

        if (result.missedFlag === 0 && result.count === 0) {
            // All blocks received — device is writing firmware to flash.
            // Wait for 0x12 Upgrade Status before declaring success.
            session.state = 'flashing';
            this._updateDb(session);
            this._emitProgress(devEui);
            auditLogger.log('fuota_manager', 'flash_write_started', devEui, {});
            log.info(`FUOTAManager: ${devEui} all blocks confirmed — waiting for 0x12 flash status`);
            this._startFlashTimeout(devEui);
        } else {
            // Update confirmed-received set before transitioning to resend.
            // missedFlag=0: complete list — all sent blocks NOT in the missed list are confirmed.
            // missedFlag=1: partial list — only confirm blocks in range 0..maxMissedBlock.
            const missedSet = new Set(result.blocks);
            if (result.missedFlag === 0) {
                for (let b = 0; b < session.blocksSent; b++) {
                    if (!missedSet.has(b)) session.confirmedBlocks.add(b);
                }
            } else if (result.blocks.length > 0) {
                const maxMissed = Math.max(...result.blocks);
                for (let b = 0; b <= maxMissed && b < session.blocksSent; b++) {
                    if (!missedSet.has(b)) session.confirmedBlocks.add(b);
                }
            }

            // Resend missed blocks then verify again
            session.state = 'resending';
            session.blocksResentSoFar = 0;
            session.lastMissedCount = result.count;
            session.lastMissedBlocks = result.blocks;
            this._updateDb(session);
            this._emitProgress(devEui);

            this._resendMissedBlocks(session, result.blocks).catch(err => {
                log.error(`FUOTAManager: resend error for ${devEui}: ${err.message}`);
                this._failSession(devEui, err.message);
            });
        }
    }

    /**
     * Start the flash-write timeout after receiving an empty 0x11.
     * If no 0x12 arrives within FUOTA_FLASH_TIMEOUT_MS the session is failed.
     */
    _startFlashTimeout(devEui) {
        const session = this.activeSessions.get(devEui);
        if (!session) return;
        clearTimeout(session._flashTimeout);
        session._flashTimeout = setTimeout(async () => {
            if (this.activeSessions.get(devEui) !== session) return;
            if (session.state !== 'flashing') return;
            await this._failSession(devEui,
                `No 0x12 upgrade status received within ${FUOTA_FLASH_TIMEOUT_MS / 60000} min of flash start`
            );
        }, FUOTA_FLASH_TIMEOUT_MS);
    }

    _handleFlashStatus(devEui, buf) {
        const session = this.activeSessions.get(devEui);
        if (!session) return;
        if (session.state !== 'flashing') return;

        clearTimeout(session._flashTimeout);
        session._flashTimeout = null;

        // byte[1] = status code; 0x00 = success
        const statusCode = buf.length > 1 ? buf[1] : 0;
        auditLogger.log('fuota_manager', 'flash_status_received', devEui, { statusCode });

        if (statusCode === 0) {
            log.info(`FUOTAManager: ${devEui} 0x12 flash status: success`);
            this._completeSession(devEui);
        } else {
            log.error(`FUOTAManager: ${devEui} 0x12 flash status: failure code 0x${statusCode.toString(16)}`);
            this._failSession(devEui, `Flash write failed with status code 0x${statusCode.toString(16)}`);
        }
    }

    async _resendMissedBlocks(session, missedBlockNums) {
        const { devEui, blocks } = session;
        log.info({ blocks: missedBlockNums }, `FUOTAManager: ${devEui} resending ${missedBlockNums.length} missed blocks`);

        for (let i = 0; i < missedBlockNums.length; i++) {
            if (session.aborted) return;
            if (this.activeSessions.get(devEui) !== session) return;

            // Pause if broker is disconnected; throws after timeout → _failSession
            await this._waitForMqtt(devEui);
            if (session.aborted || this.activeSessions.get(devEui) !== session) return;

            const blockNum = missedBlockNums[i];
            if (blockNum >= blocks.length) {
                log.warn(`FUOTAManager: ${devEui} missed block ${blockNum} out of range (total ${blocks.length})`);
                continue;
            }
            const payload = makeBlockPayload(blockNum, blocks[blockNum]);
            this._sendDownlink(devEui, 25, payload, true);
            session.blocksResentSoFar = i + 1;
            this._emitProgress(devEui);

            if (i < missedBlockNums.length - 1) {
                await sleep(session.blockIntervalMs);
            }
        }

        if (session.aborted) return;
        if (this.activeSessions.get(devEui) !== session) return;

        // Give the device time to write the resent blocks to flash before we
        // ask it to verify receipt again.
        await sleep(FUOTA_RESEND_VERIFY_DELAY_MS);
        if (session.aborted || this.activeSessions.get(devEui) !== session) return;

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

        log.info(`FUOTAManager: ${devEui} FUOTA complete after ${session.verifyAttempts} verify attempt(s)`);
        auditLogger.log('fuota_manager', 'session_complete', devEui, {
            verifyAttempts: session.verifyAttempts,
            totalBlocks: session.totalBlocks,
        });

        // Restore original device class — fire-and-forget with retry
        if (session.classCConfigured && session.originalClass) {
            this._restoreClassWithRetry(devEui, session.originalClass).catch(() => {});
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

        log.error(`FUOTAManager: ${devEui} session failed: ${reason}`);
        auditLogger.log('fuota_manager', 'session_failed', devEui, { reason });

        // Restore original device class — fire-and-forget with retry
        if (session.classCConfigured && session.originalClass) {
            this._restoreClassWithRetry(devEui, session.originalClass).catch(() => {});
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

        log.info(`FUOTAManager: ${devEui} session aborted: ${reason}`);
        auditLogger.log('fuota_manager', 'session_aborted', devEui, { reason });

        // Restore original device class — fire-and-forget with retry
        if (session.classCConfigured && session.originalClass) {
            this._restoreClassWithRetry(devEui, session.originalClass).catch(() => {});
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Pre-flight config poll.
     *
     * Before the Class C switch and init downlink, verify that the device's firmware
     * version info (captured in devices.metadata.config_updated_at on every 0x02 config
     * uplink) is recent enough. If it is older than CONFIG_FRESH_MS (default 6 h) or
     * absent, send up to CONFIG_POLL_MAX confirmed 0x0200 config requests spaced
     * CONFIG_POLL_WAIT_MS apart. Returns as soon as the device responds or after all
     * attempts are exhausted — caller always continues with the FUOTA regardless.
     *
     * @param {string} devEui
     */
    async _prefillConfig(devEui) {
        // 1. Read current config_updated_at from DB
        let configUpdatedAt = null;
        try {
            const row = await pool.query(
                `SELECT metadata->>'config_updated_at' AS config_updated_at FROM devices WHERE dev_eui = $1`,
                [devEui]
            );
            configUpdatedAt = row.rows[0]?.config_updated_at || null;
        } catch (err) {
            log.warn(`FUOTAManager: ${devEui} config pre-flight DB check failed: ${err.message}`);
        }

        // 2. If fresh enough, skip the poll entirely
        if (configUpdatedAt) {
            const ageMs = Date.now() - new Date(configUpdatedAt).getTime();
            if (ageMs < CONFIG_FRESH_MS) {
                log.info(
                    `FUOTAManager: ${devEui} config fresh ` +
                    `(age ${Math.round(ageMs / 60000)} min < ${CONFIG_FRESH_MS / 3600000}h) — skipping pre-flight poll`
                );
                return;
            }
        }

        // 3. Stale or absent — switch state and begin polling
        const session = this.activeSessions.get(devEui);
        if (session) {
            session.state = 'config_poll';
            session.configPollAttempt = 0;
            this._emitProgress(devEui);
        }

        log.info(
            `FUOTAManager: ${devEui} config stale/absent — ` +
            `starting pre-flight poll (up to ${CONFIG_POLL_MAX} attempts, ${CONFIG_POLL_WAIT_MS / 60000} min apart)`
        );
        auditLogger.log('fuota_manager', 'config_poll_start', devEui, { configUpdatedAt });

        for (let attempt = 1; attempt <= CONFIG_POLL_MAX; attempt++) {
            if (session && session.aborted) return;
            if (!this.activeSessions.has(devEui)) return;

            this._sendDownlink(devEui, 22, Buffer.from([0x02, 0x00]), true);
            if (session) session.configPollAttempt = attempt;
            this._emitProgress(devEui);
            auditLogger.log('fuota_manager', 'config_poll_sent', devEui, { attempt, maxAttempts: CONFIG_POLL_MAX });

            await sleep(CONFIG_POLL_WAIT_MS);
            if (session && session.aborted) return;
            if (!this.activeSessions.has(devEui)) return;

            // Re-check: was config_updated_at updated recently (i.e., device responded)?
            try {
                const checkRow = await pool.query(
                    `SELECT metadata->>'config_updated_at' AS config_updated_at FROM devices WHERE dev_eui = $1`,
                    [devEui]
                );
                const newUpdatedAt = checkRow.rows[0]?.config_updated_at;
                if (newUpdatedAt) {
                    const ageMs = Date.now() - new Date(newUpdatedAt).getTime();
                    // Fresh if updated within the poll window + 1 min tolerance
                    if (ageMs < CONFIG_POLL_WAIT_MS + 60000) {
                        log.info(`FUOTAManager: ${devEui} config updated after poll attempt ${attempt} — proceeding`);
                        auditLogger.log('fuota_manager', 'config_poll_success', devEui, { attempt, newUpdatedAt });
                        return;
                    }
                }
            } catch (err) {
                log.warn(`FUOTAManager: ${devEui} config poll re-check failed: ${err.message}`);
            }

            log.warn(`FUOTAManager: ${devEui} config poll attempt ${attempt}/${CONFIG_POLL_MAX} — no response yet`);
        }

        log.warn(
            `FUOTAManager: ${devEui} no config response after ${CONFIG_POLL_MAX} attempts — proceeding with FUOTA`
        );
        auditLogger.log('fuota_manager', 'config_poll_exhausted', devEui, { attempts: CONFIG_POLL_MAX });
    }

    /**
     * Restore a device's original class after FUOTA, with up to 3 attempts and
     * exponential backoff (15 s, 30 s). Called fire-and-forget from terminal states
     * so the session is never held open waiting for a network round-trip.
     */
    async _restoreClassWithRetry(devEui, originalClass) {
        const delays = [15000, 30000];
        const maxAttempts = delays.length + 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await networkClient.restoreClass(devEui, originalClass);
                const classDesc = typeof originalClass === 'string' ? originalClass : JSON.stringify(originalClass);
                log.info(`FUOTAManager: ${devEui} restored to ${classDesc} (attempt ${attempt}/${maxAttempts})`);
                auditLogger.log('fuota_manager', 'class_a_restore', devEui, { originalClass, attempt });
                return;
            } catch (err) {
                log.error(`FUOTAManager: ${devEui} class restore attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
                if (attempt < maxAttempts) {
                    await sleep(delays[attempt - 1]);
                }
            }
        }
        log.error(`FUOTAManager: ${devEui} could not restore class after ${maxAttempts} attempts — device may be stuck in ${originalClass}`);
        auditLogger.log('fuota_manager', 'class_a_restore_failed', devEui, { originalClass, maxAttempts });
    }

    _clearTimeouts(session) {
        clearTimeout(session._ackTimeout);
        clearTimeout(session._verifyTimeout);
        clearTimeout(session._sessionTimeout);
        clearTimeout(session._flashTimeout);
        session._ackTimeout = null;
        session._verifyTimeout = null;
        session._sessionTimeout = null;
        session._flashTimeout = null;
    }

    _sendDownlink(devEui, port, payloadBuf, confirmed = false) {
        // Publish in internal format — mqttClient.publish translates to ChirpStack
        const topic = `mqtt/things/${devEui}/downlink`;
        const message = JSON.stringify({
            DevEUI_downlink: {
                DevEUI: devEui,
                FPort: port,
                payload_hex: payloadBuf.toString('hex'),
                Confirmed: confirmed ? 1 : 0,
            },
        });
        // Lazy load to avoid circular dependency
        const mqttClient = require('../mqttClient');
        mqttClient.publish(topic, message);
    }

    /**
     * Wait for the MQTT broker to be connected before sending a block.
     * Returns immediately if already connected.
     * Polls every 5 s for up to FUOTA_MQTT_WAIT_MS (default 5 min), then throws —
     * the throw propagates through _sendAllBlocks/_resendMissedBlocks to _failSession.
     */
    async _waitForMqtt(devEui) {
        const mqttClient = require('../mqttClient');
        if (mqttClient.isConnected()) return;

        const maxWaitMs = parseInt(process.env.FUOTA_MQTT_WAIT_MS) || 5 * 60 * 1000;
        const deadline = Date.now() + maxWaitMs;

        log.warn(`FUOTAManager: ${devEui} MQTT broker disconnected — pausing block send`);
        auditLogger.log('fuota_manager', 'mqtt_disconnect_pause', devEui, {});

        while (Date.now() < deadline) {
            await sleep(5000);
            if (mqttClient.isConnected()) {
                log.info(`FUOTAManager: ${devEui} MQTT broker reconnected — resuming`);
                auditLogger.log('fuota_manager', 'mqtt_reconnect_resume', devEui, {});
                return;
            }
        }

        throw new Error(`MQTT broker unreachable for ${maxWaitMs / 60000} min — session failed`);
    }

    /** Convert a Set of block numbers to sorted [lo, hi] range pairs. */
    _blocksToRanges(blockSet) {
        if (!blockSet || blockSet.size === 0) return [];
        const sorted = [...blockSet].sort((a, b) => a - b);
        const ranges = [];
        let lo = sorted[0], hi = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === hi + 1) { hi = sorted[i]; }
            else { ranges.push([lo, hi]); lo = hi = sorted[i]; }
        }
        ranges.push([lo, hi]);
        return ranges;
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
                  lastMissedBlocks: session.lastMissedBlocks,
                  blocksResentSoFar: session.blocksResentSoFar ?? 0,
                  confirmedRanges: this._blocksToRanges(session.confirmedBlocks),
                  configCheckDone: session.configCheckDone ?? false,
                  classAOnly: session.classAOnly ?? false,
                  configPollAttempt: session.configPollAttempt ?? 0,
                  error: session.error,
                  firmwareName: session.firmwareName,
                  firmwareSize: session.firmwareSize,
                  blockIntervalMs: session.blockIntervalMs,
                  classCConfigured: session.classCConfigured,
                  startedAt: session.startedAt,
                  blocksSentAtStart: session.blocksSentAtStart ?? 0,
              }
            : { devEui, state: 'idle' };
        this.io.emit('fuota:progress', payload);
    }

    async _updateDb(session, isFinal = false) {
        if (!session.dbId) return;
        try {
            if (isFinal) {
                // Terminal state: clear firmware_data to reclaim Postgres TOAST storage.
                await pool.query(
                    `UPDATE fuota_sessions
                     SET status = $1, blocks_sent = $2, verify_attempts = $3,
                         last_missed_blocks = $4, error = $5,
                         completed_at = $6, updated_at = NOW(),
                         firmware_data = NULL
                     WHERE id = $7`,
                    [
                        session.state,
                        session.blocksSent,
                        session.verifyAttempts,
                        JSON.stringify(session.lastMissedBlocks || []),
                        session.error,
                        new Date(),
                        session.dbId,
                    ]
                );
            } else {
                await pool.query(
                    `UPDATE fuota_sessions
                     SET status = $1, blocks_sent = $2, verify_attempts = $3,
                         last_missed_blocks = $4, error = $5,
                         completed_at = NULL, updated_at = NOW()
                     WHERE id = $6`,
                    [
                        session.state,
                        session.blocksSent,
                        session.verifyAttempts,
                        JSON.stringify(session.lastMissedBlocks || []),
                        session.error,
                        session.dbId,
                    ]
                );
            }
        } catch (err) {
            log.error(`FUOTAManager: DB update error: ${err.message}`);
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
                lastMissedBlocks: s.lastMissedBlocks,
                blocksResentSoFar: s.blocksResentSoFar ?? 0,
                confirmedRanges: this._blocksToRanges(s.confirmedBlocks),
                configCheckDone: s.configCheckDone ?? false,
                classAOnly: s.classAOnly ?? false,
                configPollAttempt: s.configPollAttempt ?? 0,
                error: s.error,
                blockIntervalMs: s.blockIntervalMs,
                classCConfigured: s.classCConfigured,
                startedAt: s.startedAt,
                blocksSentAtStart: s.blocksSentAtStart ?? 0,
            });
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Live session overrides
    // -----------------------------------------------------------------------

    /**
     * Update the block-send interval for an active session.
     * @param {string} devEui
     * @param {number} intervalMs
     * @returns {boolean} true if the session was found and updated, false otherwise
     */
    updateBlockInterval(devEui, intervalMs) {
        const session = this.activeSessions.get(devEui);
        if (!session) return false;
        session.blockIntervalMs = intervalMs;
        log.info({ devEui, blockIntervalMs: intervalMs }, 'FUOTAManager: live block interval updated');
        return true;
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
                    log.info(`FUOTAManager: evicted firmware store entry ${id}`);
                }
            }
        }, 15 * 60 * 1000);
    }
}

const _instance = new FUOTAManager();
_instance.resolveIntervalLimits = resolveIntervalLimits;
_instance.isClassAOnly          = isClassAOnly;
_instance.initAckWaitMs = initAckWaitMs;
module.exports = _instance;
