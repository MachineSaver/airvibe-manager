const mqtt = require('mqtt');

// Config
const BROKER_URL = 'mqtt://localhost:1884';
const DELAY = 800; // ms between segments for better visibility

let client;

function connect() {
    client = mqtt.connect(BROKER_URL);

    client.on('connect', () => {
        console.log('✅ Simulator connected to MQTT\n');
        runAllScenarios();
    });

    client.on('message', (topic, message) => {
        try {
            const msg = JSON.parse(message.toString());
            const payload = Buffer.from(msg.payload, 'hex');
            const type = payload[0];
            const txId = payload[1];

            console.log(`[DOWNLINK ${msg.devEui}] Port ${msg.port} Type 0x${type.toString(16).padStart(2, '0')} TxID ${txId}`);

            if (msg.port === 20 && type === 0x03) {
                console.log('  ✅ TWIU ACK received');
            } else if (msg.port === 20 && type === 0x01) {
                console.log('  ✅ DATA ACK (Complete!)');
            } else if (msg.port === 22 && type === 0x02) {
                console.log('  ⚠️ Missing Segment Request');
            } else if (msg.port === 22 && type === 0x00 && payload[1] === 0x01) {
                console.log('  ⚠️ TWIU Request (0001)');
            }
        } catch (e) {
            // Ignore parse errors
        }
    });
}

async function runAllScenarios() {
    client.subscribe('airvibe/+/downlink');

    await sleep(2000);

    console.log('\n═══════════════════════════════════════════════');
    console.log('SCENARIO 1: Standard Tri-Axial Flow');
    console.log('═══════════════════════════════════════════════\n');
    await scenario1_StandardFlow();
    await sleep(5000);

    console.log('\n═══════════════════════════════════════════════');
    console.log('SCENARIO 2: Out of Order (Data before TWIU)');
    console.log('═══════════════════════════════════════════════\n');
    await scenario2_OutOfOrder();
    await sleep(5000);

    console.log('\n═══════════════════════════════════════════════');
    console.log('SCENARIO 3: Single Axis 1 Waveform');
    console.log('═══════════════════════════════════════════════\n');
    await scenario3_SingleAxis();
    await sleep(5000);

    console.log('\n═══════════════════════════════════════════════');
    console.log('SCENARIO 4: Single Axis 2 Waveform');
    console.log('═══════════════════════════════════════════════\n');
    await scenario4_Axis2Only();
    await sleep(5000);

    console.log('\n═══════════════════════════════════════════════');
    console.log('SCENARIO 5: Single Axis 3 Waveform');
    console.log('═══════════════════════════════════════════════\n');
    await scenario5_Axis3Only();
    await sleep(3000);

    console.log('\n✅ All scenarios complete!');
    setTimeout(() => process.exit(0), 2000);
}

async function scenario1_StandardFlow() {
    const devEui = 'STANDARD_001';
    const txId = 0x10;
    const topic = `airvibe/${devEui}/uplink`;

    const twiu = Buffer.from('03100000070003814e200015', 'hex');
    client.publish(topic, twiu);
    console.log(`[${devEui}] Sent TWIU (TxID ${txId})`);
    await sleep(DELAY);

    const seg0 = Buffer.from('011000000001000400000002000300000003fffb00010003fff900070003fffc0007000200000002fffd00000004', 'hex');
    client.publish(topic, seg0);
    console.log(`[${devEui}] Sent Segment 0`);
    await sleep(DELAY);

    const seg1 = Buffer.from('011000010000fffc00010001fffefffd0000ffff00000001000000000000fffffffffffdffff0000fffd00010000', 'hex');
    client.publish(topic, seg1);
    console.log(`[${devEui}] Sent Segment 1`);
    await sleep(DELAY);

    const seg2 = Buffer.from('05100002000000010001000000010006fffeffff000000000005fffa00000007fffafffe0004fffbffff0004fff6', 'hex');
    client.publish(topic, seg2);
    console.log(`[${devEui}] Sent Segment 2 (Final)`);
}

async function scenario2_OutOfOrder() {
    const devEui = 'OUTOFORDER_002';
    const txId = 0x20;
    const topic = `airvibe/${devEui}/uplink`;

    const seg0 = Buffer.from('012000000001000400000002000300000003fffb00010003fff900070003fffc0007000200000002fffd00000004', 'hex');
    client.publish(topic, seg0);
    console.log(`[${devEui}] Sent Segment 0 (NO TWIU YET!)`);
    await sleep(DELAY);

    const seg1 = Buffer.from('012000010000fffc00010001fffefffd0000ffff00000001000000000000fffffffffffdffff0000fffd00010000', 'hex');
    client.publish(topic, seg1);
    console.log(`[${devEui}] Sent Segment 1 (Still no TWIU)`);
    await sleep(DELAY);

    console.log(`[${devEui}] Waiting for backend to request TWIU...`);
    await sleep(2000);

    const twiu = Buffer.from('03200000070003814e200015', 'hex');
    client.publish(topic, twiu);
    console.log(`[${devEui}] ✅ TWIU arrived!`);
    await sleep(DELAY);

    const seg2 = Buffer.from('05200002000000010001000000010006fffeffff000000000005fffa00000007fffafffe0004fffbffff0004fff6', 'hex');
    client.publish(topic, seg2);
    console.log(`[${devEui}] Sent Segment 2 (Final)`);
}

async function scenario3_SingleAxis() {
    const devEui = 'SINGLEAXIS1_003';
    const txId = 0x30;
    const topic = `airvibe/${devEui}/uplink`;

    const twiu = Buffer.from('03300000010002814e20000f', 'hex');
    client.publish(topic, twiu);
    console.log(`[${devEui}] Sent TWIU (Axis 1 only)`);
    await sleep(DELAY);

    const seg0 = Buffer.from('013000000100001001020300045005060700089009100a00b00c00d00e00f', 'hex');
    client.publish(topic, seg0);
    console.log(`[${devEui}] Sent Segment 0`);
    await sleep(DELAY);

    const seg1 = Buffer.from('05300001100011001200130014', 'hex');
    client.publish(topic, seg1);
    console.log(`[${devEui}] Sent Segment 1 (Final)`);
}

async function scenario4_Axis2Only() {
    const devEui = 'SINGLEAXIS2_004';
    const txId = 0x40;
    const topic = `airvibe/${devEui}/uplink`;

    // Type 03: TWIU - 2 segments, Axis 2 only (0x02), 20kHz (0x4e20), 15 samples (0x000f)
    const twiu = Buffer.from('03400000020002814e20000f', 'hex');
    client.publish(topic, twiu);
    console.log(`[${devEui}] Sent TWIU (Axis 2 only, TxID ${txId})`);
    await sleep(DELAY);

    // Segment 0 - Only Axis 2 data (2 bytes per sample)
    const seg0 = Buffer.from('014000000200001501020350045005060700089009100a50b00c50d00e00f', 'hex');
    client.publish(topic, seg0);
    console.log(`[${devEui}] Sent Segment 0`);
    await sleep(DELAY);

    // Segment 1 (Final) - Remaining Axis 2 data
    const seg1 = Buffer.from('05400001150016001700180019', 'hex');
    client.publish(topic, seg1);
    console.log(`[${devEui}] Sent Segment 1 (Final)`);
}

async function scenario5_Axis3Only() {
    const devEui = 'SINGLEAXIS3_005';
    const txId = 0x50;
    const topic = `airvibe/${devEui}/uplink`;

    // Type 03: TWIU - 2 segments, Axis 3 only (0x04), 20kHz (0x4e20), 15 samples (0x000f)
    const twiu = Buffer.from('03500000040002814e20000f', 'hex');
    client.publish(topic, twiu);
    console.log(`[${devEui}] Sent TWIU (Axis 3 only, TxID ${txId})`);
    await sleep(DELAY);

    // Segment 0 - Only Axis 3 data (2 bytes per sample)
    const seg0 = Buffer.from('015000000300001a01020350045a05060700089a09100a50ba0c50da0e00f', 'hex');
    client.publish(topic, seg0);
    console.log(`[${devEui}] Sent Segment 0`);
    await sleep(DELAY);

    // Segment 1 (Final) - Remaining Axis 3 data  
    const seg1 = Buffer.from('05500001200021002200230024', 'hex');
    client.publish(topic, seg1);
    console.log(`[${devEui}] Sent Segment 1 (Final)`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

connect();
