export type CommandPresetType = 'simple' | 'codec' | 'waveform_ack' | 'missed_segments';

export interface CommandPreset {
  name: string;
  fPort: number;
  type: CommandPresetType;
  staticPayload?: string;
  codecInput?: Record<string, unknown>;
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
  // ─── Port 22: Commands ───
  {
    name: "Request Current TWF Info Packet",
    fPort: 22,
    type: 'codec',
    codecInput: { command_id: "request_waveform_info", parameters: [] },
    notes: "Requests the current Time Waveform configuration."
  },
  {
    name: "Request Current Sensor Configuration Packet",
    fPort: 22,
    type: 'codec',
    codecInput: { command_id: "request_config", parameters: [] },
    notes: "Requests the current sensor configuration."
  },
  {
    name: "Trigger New TWF Collection",
    fPort: 22,
    type: 'codec',
    codecInput: { command_id: "request_new_capture", parameters: [] },
    notes: "Triggers a new Time Waveform collection immediately."
  },
  {
    name: "Initialize AirVibe TPM/VSM Upgrade Session",
    fPort: 22,
    type: 'codec',
    codecInput: { command_id: "init_upgrade_session", parameters: [] },
    notes: "Warning - this will set the AirVibe into Class C Mode which will use more battery."
  },
  {
    name: "Verify Upgrade Image Data",
    fPort: 22,
    type: 'codec',
    codecInput: { command_id: "verify_upgrade_data", parameters: [] },
    notes: "Verifies the uploaded firmware image."
  },

  // ─── Port 31: Alarms ───
  {
    name: "Alarm - Set Off",
    fPort: 31,
    type: 'codec',
    codecInput: {
      alarms: {
        temperature: { enabled: false, threshold_c: 0 },
        acceleration_mg: {
          axis_1: { enabled: false, threshold: 0 },
          axis_2: { enabled: false, threshold: 0 },
          axis_3: { enabled: false, threshold: 0 }
        },
        velocity_mips: {
          axis_1: { enabled: false, threshold: 0 },
          axis_2: { enabled: false, threshold: 0 },
          axis_3: { enabled: false, threshold: 0 }
        }
      }
    },
    notes: "Disables all alarms."
  },
  {
    name: "Alarm - Set Temp 50",
    fPort: 31,
    type: 'codec',
    codecInput: {
      alarms: {
        temperature: { enabled: true, threshold_c: 50 },
        acceleration_mg: {
          axis_1: { enabled: false, threshold: 0 },
          axis_2: { enabled: false, threshold: 0 },
          axis_3: { enabled: false, threshold: 0 }
        },
        velocity_mips: {
          axis_1: { enabled: false, threshold: 0 },
          axis_2: { enabled: false, threshold: 0 },
          axis_3: { enabled: false, threshold: 0 }
        }
      }
    },
    notes: "Sets temperature alarm threshold to 50°C."
  },
  {
    name: "Alarm - Set Accel 0.5 g RMS",
    fPort: 31,
    type: 'codec',
    codecInput: {
      alarms: {
        temperature: { enabled: false, threshold_c: 0 },
        acceleration_mg: {
          axis_1: { enabled: true, threshold: 500 },
          axis_2: { enabled: true, threshold: 500 },
          axis_3: { enabled: true, threshold: 500 }
        },
        velocity_mips: {
          axis_1: { enabled: false, threshold: 0 },
          axis_2: { enabled: false, threshold: 0 },
          axis_3: { enabled: false, threshold: 0 }
        }
      }
    },
    notes: "Sets acceleration alarm to 0.5 g RMS on all axes."
  },
  {
    name: "Alarm - Set Accel 0.1 in/sec RMS",
    fPort: 31,
    type: 'codec',
    codecInput: {
      alarms: {
        temperature: { enabled: true, threshold_c: 0 },
        acceleration_mg: {
          axis_1: { enabled: false, threshold: 0 },
          axis_2: { enabled: false, threshold: 0 },
          axis_3: { enabled: false, threshold: 0 }
        },
        velocity_mips: {
          axis_1: { enabled: true, threshold: 100 },
          axis_2: { enabled: true, threshold: 100 },
          axis_3: { enabled: true, threshold: 100 }
        }
      }
    },
    notes: "Sets velocity alarm to 0.1 in/sec RMS on all axes."
  },

  // ─── Port 30: Configuration ───
  {
    name: "Configuration - Overall Only Mode 1 Minute",
    fPort: 30,
    type: 'codec',
    codecInput: {
      version: 2,
      device_settings: {
        push_mode: "overall_only",
        accel_range_g: 8,
        hw_filter: "lp_2670_hz",
        machine_off_threshold_mg: 25
      },
      waveform_config: {
        push_period_min: 15,
        samples_per_axis: 210,
        active_axes: { axis_1: true, axis_2: true, axis_3: true }
      },
      vibration_config: {
        overall_push_period_min: 1,
        high_pass_filter_hz: 2,
        low_pass_filter_hz: 5000,
        window_function: "hanning"
      },
      alarms: { test_period_min: 1 }
    }
  },
  {
    name: "Configuration - Overall Only Mode 5 Minute",
    fPort: 30,
    type: 'codec',
    codecInput: {
      version: 2,
      device_settings: {
        push_mode: "overall_only",
        accel_range_g: 8,
        hw_filter: "lp_2670_hz",
        machine_off_threshold_mg: 25
      },
      waveform_config: {
        push_period_min: 15,
        samples_per_axis: 210,
        active_axes: { axis_1: true, axis_2: true, axis_3: true }
      },
      vibration_config: {
        overall_push_period_min: 5,
        high_pass_filter_hz: 2,
        low_pass_filter_hz: 5000,
        window_function: "hanning"
      },
      alarms: { test_period_min: 5 }
    }
  },
  {
    name: "Configuration - Overall Only Mode 10 Minute",
    fPort: 30,
    type: 'codec',
    codecInput: {
      version: 2,
      device_settings: {
        push_mode: "overall_only",
        accel_range_g: 8,
        hw_filter: "lp_2670_hz",
        machine_off_threshold_mg: 25
      },
      waveform_config: {
        push_period_min: 15,
        samples_per_axis: 210,
        active_axes: { axis_1: true, axis_2: true, axis_3: true }
      },
      vibration_config: {
        overall_push_period_min: 10,
        high_pass_filter_hz: 2,
        low_pass_filter_hz: 5000,
        window_function: "hanning"
      },
      alarms: { test_period_min: 1 }
    },
    notes: "Includes 1 Minute Alarm Checks."
  },
  {
    name: "Configuration - TWF Only Mode (TriAxial)",
    fPort: 30,
    type: 'codec',
    codecInput: {
      version: 2,
      device_settings: {
        push_mode: "waveform_only",
        accel_range_g: 8,
        hw_filter: "lp_2670_hz",
        machine_off_threshold_mg: 25
      },
      waveform_config: {
        push_period_min: 15,
        samples_per_axis: 21,
        active_axes: { axis_1: true, axis_2: true, axis_3: true }
      },
      vibration_config: {
        overall_push_period_min: 2,
        high_pass_filter_hz: 2,
        low_pass_filter_hz: 5000,
        window_function: "hanning"
      },
      alarms: { test_period_min: 2 }
    }
  },
  {
    name: "Configuration - TWF Only Mode (Axis 1)",
    fPort: 30,
    type: 'codec',
    codecInput: {
      version: 2,
      device_settings: {
        push_mode: "waveform_only",
        accel_range_g: 8,
        hw_filter: "lp_2670_hz",
        machine_off_threshold_mg: 25
      },
      waveform_config: {
        push_period_min: 15,
        samples_per_axis: 63,
        active_axes: { axis_1: true, axis_2: false, axis_3: false }
      },
      vibration_config: {
        overall_push_period_min: 2,
        high_pass_filter_hz: 2,
        low_pass_filter_hz: 5000,
        window_function: "hanning"
      },
      alarms: { test_period_min: 2 }
    }
  },
  {
    name: "Configuration - TWF Only Mode (Axis 2)",
    fPort: 30,
    type: 'codec',
    codecInput: {
      version: 2,
      device_settings: {
        push_mode: "waveform_only",
        accel_range_g: 8,
        hw_filter: "lp_2670_hz",
        machine_off_threshold_mg: 25
      },
      waveform_config: {
        push_period_min: 15,
        samples_per_axis: 63,
        active_axes: { axis_1: false, axis_2: true, axis_3: false }
      },
      vibration_config: {
        overall_push_period_min: 2,
        high_pass_filter_hz: 2,
        low_pass_filter_hz: 5000,
        window_function: "hanning"
      },
      alarms: { test_period_min: 2 }
    }
  },
  {
    name: "Configuration - TWF Only Mode (Axis 3)",
    fPort: 30,
    type: 'codec',
    codecInput: {
      version: 2,
      device_settings: {
        push_mode: "waveform_only",
        accel_range_g: 8,
        hw_filter: "lp_2670_hz",
        machine_off_threshold_mg: 25
      },
      waveform_config: {
        push_period_min: 15,
        samples_per_axis: 63,
        active_axes: { axis_1: false, axis_2: false, axis_3: true }
      },
      vibration_config: {
        overall_push_period_min: 2,
        high_pass_filter_hz: 2,
        low_pass_filter_hz: 5000,
        window_function: "hanning"
      },
      alarms: { test_period_min: 2 }
    }
  },
  {
    name: "Configuration - Dual Mode 5 Min Overall, Max Tri-Axial",
    fPort: 30,
    type: 'codec',
    codecInput: {
      version: 2,
      device_settings: {
        push_mode: "overall_and_waveform",
        accel_range_g: 8,
        hw_filter: "lp_2670_hz",
        machine_off_threshold_mg: 25
      },
      waveform_config: {
        push_period_min: 15,
        samples_per_axis: 4096,
        active_axes: { axis_1: true, axis_2: true, axis_3: true }
      },
      vibration_config: {
        overall_push_period_min: 5,
        high_pass_filter_hz: 2,
        low_pass_filter_hz: 5000,
        window_function: "hanning"
      },
      alarms: { test_period_min: 5 }
    }
  },

  // ─── Port 20: Waveform Control ───
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

  // ─── Port 21: Missing Segments ───
  {
    name: "Waveform Control - TWF Missing Segments",
    fPort: 21,
    type: 'missed_segments',
    notes: "Requests re-transmission of missing segments."
  }
];
