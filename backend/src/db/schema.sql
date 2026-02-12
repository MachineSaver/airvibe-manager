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
    status VARCHAR(20) DEFAULT 'pending', -- pending, complete, failed
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
