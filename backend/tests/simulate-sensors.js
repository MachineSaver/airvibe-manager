#!/usr/bin/env node

const mqtt = require('mqtt');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const API_URL = process.env.API_URL || 'http://localhost:4000';
const DELAY_MS = 200; // delay between packets

const DEV_EUIS = [
    '8C1F642113000556',
    '8C1F642113000789',
    '8C1F642113000ABC',
    '8C1F642113000DEF',
];

const SENSOR_NAMES = {
    '8C1F642113000556': 'Sensor-A (Pump House)',
    '8C1F642113000789': 'Sensor-B (Compressor)',
    '8C1F642113000ABC': 'Sensor-C (Motor Bay)',
    '8C1F642113000DEF': 'Sensor-D (Backup)',
};

// Real waveform packets (TxID 0x19)
const WAVEFORM_PACKETS = [
    '03190000070a0081204e420008',                                                                                           // TWIU
    '011900000600a60209000900440207000700ca0103000600350101000700930005000500f1ffffff050050fff9ff',                         // TWD 0
    '011901000100b8fef7ff0000dbfdf6fffdff94fdf7ff02007afdfbff050089fdfaff0300b9fdf6fffeff11fef8ff',                       // TWD 1
    '011902000f9ff8afef9fff9ff19fffcfff4ffafff0100f3ff53000500fafff8001200ffff90010f00fcff8b020d00',                     // TWD 2
    '011903000fbffd3020c00fffff5020d00fcffed020d000000c502080005001202070008008d0100000d00eb000000',                     // TWD 3
    '011904000800400003000500a9fff0000040002fffdff030076fef4ff010003fef2ff0500b1fdfaff090081fdfdff',                     // TWD 4
    '011905000800a9afd5ff0400e0fdf4ff000045fefafffaffc6fefefffbff5efffdfff8fffffffefff9ffa700fdff',                     // TWD 5
    '011906000fff490101000000db010300ffffb6020100fefff10205000200040305000500e6020200ffffab020300',                       // TWD 6
    '011907000000cf0107000400cf01090007003f0105000300faffffff030057ff00000800c1fe000003003cfefdff',                       // TWD 7
    '011908000000d8fdf6ffffff98fdf7fffcff78fdfffffdff87fdf7fff9ff0ffefefff8ff85fefdfff4ff0eff0000',                       // TWD 8
    '051909000f4ffacff0300f9ff4e000200fcffee000800',                                                                       // TWF 9
];

const OVERALL_PAYLOAD_HEX = '020000da9a631400150013000a000f000d00';

// --- Varied overall payloads to make each reading look different ---
// Type 2 overall: 02 0000 [vibX_rms 2B] [vibY_rms 2B] [vibZ_rms 2B] [temp 2B] [battery 2B] [peak fields...]
function generateOverallPayload() {
    // Randomize vibration, temperature, and battery values within realistic ranges
    const vibX = 10 + Math.floor(Math.random() * 30);  // 10-40 mg
    const vibY = 8 + Math.floor(Math.random() * 25);
    const vibZ = 5 + Math.floor(Math.random() * 20);
    const temp = 20 + Math.floor(Math.random() * 15);   // 20-35 °C
    const battery = 10 + Math.floor(Math.random() * 8); // 10-18 (x0.1V)
    const peakX = vibX + Math.floor(Math.random() * 10);
    const peakY = vibY + Math.floor(Math.random() * 10);
    const peakZ = vibZ + Math.floor(Math.random() * 10);

    const buf = Buffer.alloc(19);
    buf[0] = 0x02; // type
    buf.writeUInt16BE(0, 1); // reserved
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectMqtt() {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(BROKER_URL, {
            clientId: 'sensor-simulator_' + Math.random().toString(16).substr(2, 8),
        });
        client.on('connect', () => {
            console.log(`Connected to MQTT broker at ${BROKER_URL}`);
            resolve(client);
        });
        client.on('error', reject);
    });
}

function publish(client, devEui, payloadHex, fPort = 8) {
    const topic = `mqtt/things/${devEui}/uplink`;
    const message = buildActilityUplink(devEui, payloadHex, fPort);
    return new Promise((resolve, reject) => {
        client.publish(topic, message, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// --- Formatting helpers ---
function elapsed(startTime) {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function sensorLabel(devEui) {
    return SENSOR_NAMES[devEui] || devEui;
}

// ============================
// Scenario functions (quick)
// ============================

async function scenario1(client) {
    console.log('\n--- Scenario 1: Single sensor basic uplink ---');
    const devEui = DEV_EUIS[0];
    await publish(client, devEui, OVERALL_PAYLOAD_HEX);
    console.log(`  Sent Type 2 (Overall) for ${devEui}`);
    await sleep(DELAY_MS);
}

async function scenario2(client) {
    console.log('\n--- Scenario 2: Full waveform transfer (one sensor) ---');
    const devEui = DEV_EUIS[0];
    for (let i = 0; i < WAVEFORM_PACKETS.length; i++) {
        await publish(client, devEui, WAVEFORM_PACKETS[i]);
        console.log(`  Sent packet ${i}/${WAVEFORM_PACKETS.length - 1} for ${devEui}`);
        await sleep(DELAY_MS);
    }
}

async function scenario3(client) {
    console.log('\n--- Scenario 3: Multi-sensor parallel waveform ---');
    const euis = DEV_EUIS.slice(0, 3);
    for (let pktIdx = 0; pktIdx < WAVEFORM_PACKETS.length; pktIdx++) {
        for (const devEui of euis) {
            const txIdOffset = euis.indexOf(devEui);
            const pkt = replaceTransactionId(WAVEFORM_PACKETS[pktIdx], 0x19 + txIdOffset);
            await publish(client, devEui, pkt);
            console.log(`  Sent packet ${pktIdx} for ${devEui} (TxID 0x${(0x19 + txIdOffset).toString(16)})`);
            await sleep(50);
        }
        await sleep(DELAY_MS);
    }
}

async function scenario4(client) {
    console.log('\n--- Scenario 4: Out-of-order arrival ---');
    const devEui = DEV_EUIS[3];
    const shuffled = [5, 3, 7, 1, 8, 0, 6, 4, 2, 9, 10];
    const reordered = shuffled.map(i => WAVEFORM_PACKETS[i]);

    const txId = 0x1C;
    for (let i = 0; i < reordered.length; i++) {
        const pkt = replaceTransactionId(reordered[i], txId);
        await publish(client, devEui, pkt);
        const type = pkt.substring(0, 2);
        const typeName = type === '03' ? 'TWIU' : type === '05' ? 'TWF' : `TWD`;
        console.log(`  Sent ${typeName} (original idx ${shuffled[i]}) for ${devEui}`);
        await sleep(DELAY_MS);
    }
}

function replaceTransactionId(hexPayload, newTxId) {
    return hexPayload.substring(0, 2) + newTxId.toString(16).padStart(2, '0') + hexPayload.substring(4);
}

// ============================
// Demo mode — 5 minute live simulation
// ============================

async function runDemo(client, durationMinutes) {
    const durationMs = durationMinutes * 60 * 1000;
    const overallIntervalMs = 30 * 1000;  // Overall data every 30 seconds per sensor
    const euis = DEV_EUIS.slice(0, 3);    // 3 sensors
    const startTime = Date.now();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  LIVE DEMO MODE — ${durationMinutes} minutes, ${euis.length} sensors`);
    console.log(`  Overall vibration data every ${overallIntervalMs / 1000}s per sensor`);
    console.log(`  Waveform captures staggered across the run`);
    console.log(`  Press Ctrl+C to stop early`);
    console.log(`${'='.repeat(60)}\n`);

    // Print sensor roster
    for (const eui of euis) {
        console.log(`  ${sensorLabel(eui)}  [${eui}]`);
    }
    console.log('');

    // Schedule waveform captures at specific times
    // Sensor A at 0:45, Sensor B at 1:30, Sensor C at 2:30, Sensor A again at 3:45
    const waveformSchedule = [
        { offsetMs: 45 * 1000,  euiIdx: 0, txId: 0x20, label: 'Capture #1' },
        { offsetMs: 90 * 1000,  euiIdx: 1, txId: 0x21, label: 'Capture #2' },
        { offsetMs: 150 * 1000, euiIdx: 2, txId: 0x22, label: 'Capture #3' },
        { offsetMs: 225 * 1000, euiIdx: 0, txId: 0x23, label: 'Capture #4' },
    ];

    // Track what's been sent
    const waveformsSent = new Set();
    const waveformsInProgress = new Map(); // euiIdx -> { txId, nextPktIdx, label }
    let lastOverallTime = 0;
    let overallRound = 0;

    while (Date.now() - startTime < durationMs) {
        const now = Date.now();
        const elapsedMs = now - startTime;

        // --- Send overall data every 30 seconds (staggered across sensors) ---
        if (now - lastOverallTime >= overallIntervalMs) {
            lastOverallTime = now;
            overallRound++;
            console.log(`\n[${elapsed(startTime)}] ── Overall vibration round #${overallRound} ──`);
            for (let i = 0; i < euis.length; i++) {
                const payload = generateOverallPayload();
                await publish(client, euis[i], payload);
                console.log(`  ${sensorLabel(euis[i])}  → Overall (Type 2)  payload: ${payload}`);
                // Stagger by 2 seconds between sensors
                await sleep(2000);
            }
        }

        // --- Check if any waveform captures should start ---
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
                console.log(`\n[${elapsed(startTime)}] ── ${sched.label}: ${sensorLabel(euis[sched.euiIdx])} starting waveform (TxID 0x${sched.txId.toString(16)}) ──`);
            }
        }

        // --- Drip-feed waveform packets (one packet per sensor per tick) ---
        for (const [euiIdx, state] of waveformsInProgress.entries()) {
            if (state.nextPktIdx < WAVEFORM_PACKETS.length) {
                const pkt = replaceTransactionId(WAVEFORM_PACKETS[state.nextPktIdx], state.txId);
                await publish(client, euis[euiIdx], pkt);

                const type = pkt.substring(0, 2);
                const typeName = type === '03' ? 'TWIU' : type === '05' ? 'TWF' : `TWD ${state.nextPktIdx - 1}`;
                const progress = `[${state.nextPktIdx + 1}/${WAVEFORM_PACKETS.length}]`;
                console.log(`[${elapsed(startTime)}]   ${sensorLabel(euis[euiIdx])}  → ${typeName}  ${progress}`);

                state.nextPktIdx++;

                if (state.nextPktIdx >= WAVEFORM_PACKETS.length) {
                    console.log(`[${elapsed(startTime)}]   ${sensorLabel(euis[euiIdx])}  ✓ Waveform ${state.label} complete`);
                    waveformsInProgress.delete(euiIdx);
                }
            }
        }

        // Tick rate — 3 seconds between loop iterations gives a nice paced feel.
        // Waveform packets come ~every 3s (realistic for LoRaWAN uplink intervals).
        await sleep(3000);
    }

    console.log(`\n[${elapsed(startTime)}] ── Demo complete ──\n`);

    // Final stats
    await sleep(2000);
    await verifyApi();
}

// ============================
// API verification
// ============================

async function verifyApi() {
    console.log('\n--- API Verification ---');
    const fetch = globalThis.fetch;

    try {
        const devicesRes = await fetch(`${API_URL}/api/devices`);
        const devices = await devicesRes.json();
        console.log(`  GET /api/devices: ${devices.length} devices`);
        for (const d of devices) {
            console.log(`    ${d.dev_eui} — uplinks: ${d.uplink_count}, downlinks: ${d.downlink_count}`);
        }
        console.log(`  ${devices.length >= 3 ? 'PASS' : 'FAIL'}: Expected >= 3 devices`);

        const messagesRes = await fetch(`${API_URL}/api/messages?device_eui=${DEV_EUIS[0]}`);
        const messages = await messagesRes.json();
        console.log(`  GET /api/messages?device_eui=${DEV_EUIS[0]}: ${messages.length} messages`);
        console.log(`  ${messages.length > 0 ? 'PASS' : 'FAIL'}: Expected messages for ${DEV_EUIS[0]}`);

        const statsRes = await fetch(`${API_URL}/api/stats`);
        const stats = await statsRes.json();
        console.log(`  GET /api/stats: devices=${stats.total_devices}, messages=${stats.total_messages}, last_hour=${stats.messages_last_hour}, waveforms=${stats.total_waveforms}`);

        const waveformsRes = await fetch(`${API_URL}/api/waveforms`);
        const waveforms = await waveformsRes.json();
        console.log(`  GET /api/waveforms: ${waveforms.length} waveforms`);
    } catch (err) {
        console.error('  API verification failed:', err.message);
    }
}

// ============================
// Main
// ============================

async function main() {
    const args = process.argv.slice(2);

    const isDemo = args.includes('--demo');
    const durationIdx = args.indexOf('--duration');
    const durationMinutes = durationIdx >= 0 ? parseFloat(args[durationIdx + 1]) : 5;

    const scenarioArg = args.indexOf('--scenario');
    const specificScenario = scenarioArg >= 0 ? parseInt(args[scenarioArg + 1]) : null;

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage: node simulate-sensors.js [options]

Options:
  --demo                Run live demo mode (watch in browser)
  --duration <minutes>  Demo duration in minutes (default: 5)
  --scenario <1-4>      Run a specific quick scenario
  (no args)             Run all quick scenarios sequentially

Demo mode simulates 3 sensors over the specified duration:
  - Overall vibration data every 30 seconds per sensor
  - Waveform captures staggered across the run
  - Realistic LoRaWAN timing (~3s between packets)

Quick scenarios:
  1  Single sensor basic uplink
  2  Full waveform transfer (one sensor)
  3  Multi-sensor parallel waveform
  4  Out-of-order packet arrival
`);
        return;
    }

    const client = await connectMqtt();

    if (isDemo) {
        await runDemo(client, durationMinutes);
    } else if (specificScenario) {
        const scenarios = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4 };
        if (scenarios[specificScenario]) {
            await scenarios[specificScenario](client);
        } else {
            console.error(`Unknown scenario ${specificScenario}. Available: 1-4`);
        }
        console.log('\n  Waiting 3s for backend processing...');
        await sleep(3000);
        await verifyApi();
    } else {
        const scenarios = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4 };
        for (const [, fn] of Object.entries(scenarios)) {
            await fn(client);
            await sleep(500);
        }
        console.log('\n  Waiting 3s for backend processing...');
        await sleep(3000);
        await verifyApi();
    }

    client.end();
    console.log('\nDone.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
