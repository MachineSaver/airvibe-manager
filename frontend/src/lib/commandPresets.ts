export type CommandPresetType = 'simple' | 'waveform_ack' | 'missed_segments';

export interface CommandPreset {
  name: string;
  fPort: number;
  type: CommandPresetType;
  staticPayload?: string;
  notes?: string;
  params?: {
    label: string;
    key: string;
    type: 'text' | 'number' | 'hex';
    placeholder?: string;
    description?: string;
  }[];
}

export const COMMAND_PRESETS: CommandPreset[] = [
  {
    name: "Request Current TWF Info Packet",
    fPort: 22,
    type: 'simple',
    staticPayload: "0001",
    notes: "Requests the current Time Waveform configuration."
  },
  {
    name: "Request Current Sensor Configuration Packet",
    fPort: 22,
    type: 'simple',
    staticPayload: "0002",
    notes: "Requests the current sensor configuration."
  },
  {
    name: "Trigger New TWF Collection",
    fPort: 22,
    type: 'simple',
    staticPayload: "0003",
    notes: "Triggers a new Time Waveform collection immediately."
  },
  {
    name: "Initialize AirVibe TPM/VSM Upgrade Session",
    fPort: 22,
    type: 'simple',
    staticPayload: "0005",
    notes: "Warning - this will set the AirVibe into Class C Mode which will use more battery."
  },
  {
    name: "Verify Upgrade Image Data",
    fPort: 22,
    type: 'simple',
    staticPayload: "0006",
    notes: "Verifies the uploaded firmware image."
  },
  {
    name: "Alarm - Set Off",
    fPort: 31,
    type: 'simple',
    staticPayload: "00000000000000000000000000000000",
    notes: "Disables all alarms."
  },
  {
    name: "Alarm - Set Temp 50",
    fPort: 31,
    type: 'simple',
    staticPayload: "00011388000000000000000000000000",
    notes: "Sets temperature alarm threshold to 50."
  },
  {
    name: "Alarm - Set Accel 0.5 g RMS",
    fPort: 31,
    type: 'simple',
    staticPayload: "000E000001F401F401F4000000000000",
    notes: "Sets acceleration alarm to 0.5 g RMS."
  },
  {
    name: "Alarm - Set Accel 0.1 in/sec RMS",
    fPort: 31,
    type: 'simple',
    staticPayload: "00710000000000000000006400640064",
    notes: "Sets acceleration alarm to 0.1 in/sec RMS."
  },
  {
    name: "Configuration - Overall Only Mode 1 Minute",
    fPort: 30,
    type: 'simple',
    staticPayload: "0201070881000F000100D2000213880100010019"
  },
  {
    name: "Configuration - Overall Only Mode 5 Minute",
    fPort: 30,
    type: 'simple',
    staticPayload: "0201070881000F000500D2000213880100050019"
  },
  {
    name: "Configuration - Overall Only Mode 10 Minute",
    fPort: 30,
    type: 'simple',
    staticPayload: "0201070881000F000A00D2000213880100010019",
    notes: "Includes 1 Minute Alarm Checks."
  },
  {
    name: "Configuration - TWF Only Mode (TriAxial)",
    fPort: 30,
    type: 'simple',
    staticPayload: "0202070881000f00020015000213880100020019"
  },
  {
    name: "Configuration - TWF Only Mode (Axis 1)",
    fPort: 30,
    type: 'simple',
    staticPayload: "0202010881000f0002003f000213880100020019"
  },
  {
    name: "Configuration - TWF Only Mode (Axis 2)",
    fPort: 30,
    type: 'simple',
    staticPayload: "0202020881000f0002003f000213880100020019"
  },
  {
    name: "Configuration - TWF Only Mode (Axis 3)",
    fPort: 30,
    type: 'simple',
    staticPayload: "0202040881000f0002003f000213880100020019"
  },
  {
    name: "Configuration - Dual Mode 5 Min Overall, Max Tri-Axial",
    fPort: 30,
    type: 'simple',
    staticPayload: "0203070881000F00051000000213880100050019"
  },
  {
    name: "Waveform Control - TWI Acknowledge",
    fPort: 20,
    type: 'waveform_ack',
    notes: "Signals receipt of waveform info. Command byte is 03.",
    params: [{ label: "Waveform TXID (Hex)", key: "txid", type: "hex", placeholder: "FF", description: "1 Byte Hex" }]
  },
  {
    name: "Waveform Control - TWD Acknowledge",
    fPort: 20,
    type: 'waveform_ack',
    notes: "Signals verification of no missing segments. Command byte is 01.",
    params: [{ label: "Waveform TXID (Hex)", key: "txid", type: "hex", placeholder: "FF", description: "1 Byte Hex" }]
  },
  {
    name: "Waveform Control - TWF Missing Segments",
    fPort: 21,
    type: 'missed_segments',
    notes: "Requests re-transmission of missing segments."
  }
];
