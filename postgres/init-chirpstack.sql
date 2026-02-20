-- Create the ChirpStack database alongside the AirVibe database.
-- This script runs automatically on first container initialization
-- (i.e., when the postgres_data volume is empty / first boot).
-- For existing installs, run manually:
--   docker exec mqtt-manager-postgres psql -U postgres -c "CREATE DATABASE chirpstack;"
CREATE DATABASE chirpstack;
