-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Waveforms Table
CREATE TABLE IF NOT EXISTS waveforms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_eui VARCHAR(50) NOT NULL,
    transaction_id INTEGER NOT NULL,
    session_id VARCHAR(100) GENERATED ALWAYS AS (device_eui || '_' || transaction_id) STORED, -- Logical grouping
    start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending', -- pending, complete, failed, aborted
    expected_segments INTEGER,
    received_segments_count INTEGER DEFAULT 0,
    metadata JSONB, -- Sample rate, axis config, etc.
    final_data JSONB, -- Assembled waveform data
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(device_eui, transaction_id, start_time) -- Composite key to handle rollover, though start_time makes it tricky. 
    -- Better approach for rollover: We rely on the application to close/fail old transactions.
    -- For active ingestion, we query for status='pending' AND device_eui AND transaction_id.
);

-- Index for fast lookups of active transactions
CREATE INDEX IF NOT EXISTS idx_waveforms_active ON waveforms(device_eui, transaction_id) WHERE status = 'pending';

-- Segments Table
CREATE TABLE IF NOT EXISTS waveform_segments (
    waveform_id UUID REFERENCES waveforms(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (waveform_id, segment_index)
);

-- Devices Table
CREATE TABLE IF NOT EXISTS devices (
    dev_eui VARCHAR(50) PRIMARY KEY,
    first_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_uplink_at TIMESTAMP WITH TIME ZONE,
    last_downlink_at TIMESTAMP WITH TIME ZONE,
    uplink_count INTEGER DEFAULT 0,
    downlink_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen DESC);

-- Messages Table
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    device_eui VARCHAR(50) NOT NULL REFERENCES devices(dev_eui) ON DELETE CASCADE,
    topic VARCHAR(255) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('uplink', 'downlink')),
    payload JSONB NOT NULL,
    payload_hex TEXT,
    fport INTEGER,
    packet_type SMALLINT,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_device_time ON messages(device_eui, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction_time ON messages(direction, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(received_at DESC);
