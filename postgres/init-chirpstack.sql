-- Create the ChirpStack database alongside the AirVibe database.
-- This script runs automatically on first container initialization
-- (i.e., when the postgres_data volume is empty / first boot).
-- For existing installs, run manually:
--   docker exec mqtt-manager-postgres psql -U postgres -c "CREATE DATABASE chirpstack;"
--   docker exec mqtt-manager-postgres psql -U postgres -d chirpstack -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
CREATE DATABASE chirpstack;

-- pg_trgm is required by ChirpStack for GIN trigram indexes (name search).
-- Must be enabled before the first ChirpStack startup runs its migrations.
\connect chirpstack
CREATE EXTENSION IF NOT EXISTS pg_trgm;
