const mqttClient = require('../mqttClient');

const DEV_EUIS = [
    '8C1F642113000556',
    '8C1F642113000789',
    '8C1F642113000ABC',
];

const SENSOR_NAMES = {
    '8C1F642113000556': 'Sensor-A (Pump House)',
    '8C1F642113000789': 'Sensor-B (Compressor)',
    '8C1F642113000ABC': 'Sensor-C (Motor Bay)',
};

// Real waveform packets (TxID 0x19 — replaced per capture)
// Canonical source: frontend/src/utils/waveformTracker.ts EXAMPLE_PACKETS
const WAVEFORM_PACKETS = [
    '03190000070a0081204e420008',
    '011900000600a60209000900440207000700ca0103000600350101000700930005000500f1ffffff050050fff9ff',
    '011901000100b8fef7ff0000dbfdf6fffdff94fdf7ff02007afdfbff050089fdfaff0300b9fdf6fffeff11fef8ff',
    '01190200f9ff8afef9fff9ff19fffcfff4ffafff0100f3ff53000500fafff8001200ffff90010f00fcff8b020d00',
    '01190300fbffd3020c00fffff5020d00fcffed020d000000c502080005001202070008008d0100000d00eb000000',
    '0119040008004000030005009fff0000040002fffdff030076fef4ff010003fef2ff0500b1fdfaff090081fdfdff',
    '0119050008009afdf5ff0400e0fdf4ff000045fefafffaffc6fefefffbff5efffdfff8fffffffefff9ffa700fdff',
    '01190600ffff490101000000db010300ffffb6020100fefff10205000200040305000500e6020200ffffab020300',
    '011907000000cf0107000400cf01090007003f0105000300faffffff030057ff00000800c1fe000003003cfefdff',
    '011908000000d8fdf6ffffff98fdf7fffcff78fdfffffdff87fdf7fff9ff0ffefefff8ff85fefdfff4ff0eff0000',
    '05190900f4ffacff0300f9ff4e000200fcffee000800',
];

function generateOverallPayload() {
    const vibX = 10 + Math.floor(Math.random() * 30);
    const vibY = 8 + Math.floor(Math.random() * 25);
    const vibZ = 5 + Math.floor(Math.random() * 20);
    const temp = 20 + Math.floor(Math.random() * 15);
    const battery = 10 + Math.floor(Math.random() * 8);
    const peakX = vibX + Math.floor(Math.random() * 10);
    const peakY = vibY + Math.floor(Math.random() * 10);
    const peakZ = vibZ + Math.floor(Math.random() * 10);

    const buf = Buffer.alloc(19);
    buf[0] = 0x02;
    buf.writeUInt16BE(0, 1);
    buf.writeUInt16BE(vibX, 3);
    buf.writeUInt16BE(vibY, 5);
    buf.writeUInt16BE(vibZ, 7);
    buf.writeUInt16BE(temp, 9);
    buf.writeUInt16BE(battery, 11);
    buf.writeUInt16BE(peakX, 13);
    buf.writeUInt16BE(peakY, 15);
    buf.writeUInt16BE(peakZ, 17);
    return buf.toString('hex');
}

function buildActilityUplink(devEui, payloadHex, fPort = 8) {
    return JSON.stringify({
        DevEUI_uplink: {
            Time: new Date().toISOString(),
            DevEUI: devEui,
            FPort: fPort,
            FCntUp: Math.floor(Math.random() * 65535),
            payload_hex: payloadHex,
            LrrRSSI: -80 - Math.floor(Math.random() * 30),
            LrrSNR: 5 + Math.floor(Math.random() * 10),
            CustomerData: { alr: { pro: 'LORA/Generic', ver: '1' } },
        }
    });
}

function replaceTransactionId(hexPayload, newTxId) {
    return hexPayload.substring(0, 2) + newTxId.toString(16).padStart(2, '0') + hexPayload.substring(4);
}

class DemoSimulator {
    constructor() {
        this.running = false;
        this.startTime = null;
        this.durationMs = 0;
        this.abortController = null;
        this.log = [];
        this.overallRound = 0;
        this.waveformsCaptured = 0;
    }

    getStatus() {
        if (!this.running) {
            return { running: false };
        }
        const elapsedMs = Date.now() - this.startTime;
        const remainingMs = Math.max(0, this.durationMs - elapsedMs);
        return {
            running: true,
            elapsed_seconds: Math.floor(elapsedMs / 1000),
            remaining_seconds: Math.floor(remainingMs / 1000),
            duration_seconds: Math.floor(this.durationMs / 1000),
            sensors: DEV_EUIS.length,
            overall_rounds: this.overallRound,
            waveforms_captured: this.waveformsCaptured,
            recent_log: this.log.slice(-20),
        };
    }

    start(durationMinutes = 5) {
        if (this.running) {
            return { error: 'Demo is already running' };
        }

        this.running = true;
        this.stopped = false;
        this.startTime = Date.now();
        this.durationMs = durationMinutes * 60 * 1000;
        this.log = [];
        this.overallRound = 0;
        this.waveformsCaptured = 0;

        this._run().catch(err => {
            if (err.message !== 'stopped') {
                this._log(`Demo error: ${err.message}`);
            }
        }).finally(() => {
            this.running = false;
            this._log('Demo finished');
        });

        return { started: true, duration_minutes: durationMinutes, sensors: DEV_EUIS.length };
    }

    stop() {
        if (!this.running) {
            return { error: 'Demo is not running' };
        }
        this.stopped = true;
        this.running = false;
        this._log('Demo stopped by user');
        return { stopped: true };
    }

    _log(msg) {
        const entry = `[${this._elapsed()}] ${msg}`;
        this.log.push(entry);
        console.log(`[DemoSim] ${entry}`);
        // Keep log bounded
        if (this.log.length > 200) this.log.shift();
    }

    _elapsed() {
        const secs = Math.floor((Date.now() - this.startTime) / 1000);
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    _publish(devEui, payloadHex, fPort = 8) {
        const topic = `mqtt/things/${devEui}/uplink`;
        const message = buildActilityUplink(devEui, payloadHex, fPort);
        mqttClient.publish(topic, message);
    }

    async _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _checkStopped() {
        if (this.stopped) throw new Error('stopped');
    }

    async _run() {
        const overallIntervalMs = 30 * 1000;
        const tickMs = 3000;

        this._log(`Demo started: ${DEV_EUIS.length} sensors, ${Math.floor(this.durationMs / 60000)} min`);
        for (const eui of DEV_EUIS) {
            this._log(`  ${SENSOR_NAMES[eui]}  [${eui}]`);
        }

        // Waveform schedule (offsets in ms)
        const waveformSchedule = [
            { offsetMs: 45 * 1000,  euiIdx: 0, txId: 0x20, label: 'Capture #1' },
            { offsetMs: 90 * 1000,  euiIdx: 1, txId: 0x21, label: 'Capture #2' },
            { offsetMs: 150 * 1000, euiIdx: 2, txId: 0x22, label: 'Capture #3' },
            { offsetMs: 225 * 1000, euiIdx: 0, txId: 0x23, label: 'Capture #4' },
        ];

        const waveformsSent = new Set();
        const waveformsInProgress = new Map();
        let lastOverallTime = 0;

        while (Date.now() - this.startTime < this.durationMs) {
            this._checkStopped();

            const now = Date.now();
            const elapsedMs = now - this.startTime;

            // Overall data every 30 seconds
            if (now - lastOverallTime >= overallIntervalMs) {
                lastOverallTime = now;
                this.overallRound++;
                this._log(`Overall vibration round #${this.overallRound}`);
                for (let i = 0; i < DEV_EUIS.length; i++) {
                    const payload = generateOverallPayload();
                    this._publish(DEV_EUIS[i], payload);
                    this._log(`  ${SENSOR_NAMES[DEV_EUIS[i]]} → Overall (Type 2)`);
                    await this._sleep(2000);
                }
            }

            // Start scheduled waveform captures
            for (const sched of waveformSchedule) {
                const key = `${sched.euiIdx}-${sched.txId}`;
                if (waveformsSent.has(key)) continue;
                if (elapsedMs >= sched.offsetMs && !waveformsInProgress.has(sched.euiIdx)) {
                    waveformsSent.add(key);
                    waveformsInProgress.set(sched.euiIdx, {
                        txId: sched.txId,
                        nextPktIdx: 0,
                        label: sched.label,
                    });
                    this._log(`${sched.label}: ${SENSOR_NAMES[DEV_EUIS[sched.euiIdx]]} starting waveform (TxID 0x${sched.txId.toString(16)})`);
                }
            }

            // Drip-feed waveform packets
            for (const [euiIdx, state] of waveformsInProgress.entries()) {
                if (state.nextPktIdx < WAVEFORM_PACKETS.length) {
                    const pkt = replaceTransactionId(WAVEFORM_PACKETS[state.nextPktIdx], state.txId);
                    this._publish(DEV_EUIS[euiIdx], pkt);

                    const type = pkt.substring(0, 2);
                    const typeName = type === '03' ? 'TWIU' : type === '05' ? 'TWF' : `TWD ${state.nextPktIdx - 1}`;
                    const progress = `[${state.nextPktIdx + 1}/${WAVEFORM_PACKETS.length}]`;
                    this._log(`  ${SENSOR_NAMES[DEV_EUIS[euiIdx]]} → ${typeName}  ${progress}`);

                    state.nextPktIdx++;

                    if (state.nextPktIdx >= WAVEFORM_PACKETS.length) {
                        this._log(`  ${SENSOR_NAMES[DEV_EUIS[euiIdx]]} waveform ${state.label} complete`);
                        this.waveformsCaptured++;
                        waveformsInProgress.delete(euiIdx);
                    }
                }
            }

            await this._sleep(tickMs);
        }
    }
}

module.exports = new DemoSimulator();
