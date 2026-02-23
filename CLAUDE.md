# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AirVibe Waveform Manager is a Docker-based platform for managing AirVibe vibration sensors over LoRaWAN. It supports two deployment modes driven by the `NETWORK_SERVER` environment variable:

- **on-premise** (`NETWORK_SERVER=chirpstack`, default): Bundles ChirpStack v4 (open-source LoRaWAN Network + Application Server) in Docker. No cloud account, no internet required at runtime.
- **cloud** (`NETWORK_SERVER=thingpark`): Connects to Actility ThingPark. AirVibe runs as the application layer only; ThingPark handles LoRaWAN provisioning and payload decryption.

Both modes share the same codebase. The adapter layer in `backend/src/adapters/` isolates all network-server-specific format differences.

## Build & Run Commands

### Docker (primary method)
```bash
cp .env.example .env
docker compose up -d --build        # Start stack (8 services full, 4 app-only)
docker compose restart mqtt-broker   # Restart broker (e.g. after cert changes)
docker compose logs -f chirpstack    # Watch ChirpStack startup (full profile)
```

### Local development (without Docker)
```bash
# Backend (Express + Socket.io on port 4000)
cd backend && npm install && npm run dev    # Uses nodemon for auto-reload

# Frontend (Next.js on port 3000)
cd frontend && npm install && npm run dev
```

### Frontend lint
```bash
cd frontend && npm run lint    # ESLint 9 flat config with next/core-web-vitals
```

### Frontend build
```bash
cd frontend && npm run build
```

### Backend unit tests
```bash
cd backend && npm test    # Jest — adapter and waveform tests
```

## Architecture

### Services (docker-compose.yml)

Services marked `profiles: [full]` only start when `COMPOSE_PROFILES=full`. App-only and ThingPark modes start the remaining 4 services.

| Container | Profile | Purpose |
|---|---|---|
| `chirpstack-gateway-bridge` | full | Accepts Semtech UDP Packet Forwarder on 1700/UDP, relays to Mosquitto |
| `chirpstack-db-init` | full | One-shot sidecar: creates chirpstack DB + pg_trgm extension idempotently, then exits |
| `chirpstack` | full | LoRaWAN Network + Application Server (port 8080). Handles MAC, join, ADR, decryption |
| `chirpstack-redis` | full | ChirpStack device session state |
| `mqtt-broker` (Mosquitto) | full | MQTT broker (1883/8883) shared between ChirpStack and backend |
| `mqtt-manager-postgres` | always | PostgreSQL 16 — `airvibe` DB (application data) + `chirpstack` DB (on-premise only) |
| `mqtt-manager-backend` | always | Express + Socket.io + MQTT client |
| `mqtt-manager-frontend` | always | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| `mqtt-manager-caddy` | always | Reverse proxy (80/443). Generates Caddyfile at runtime from `NETWORK_SERVER` + `DOMAIN` |

### Real-time data flow

**On-premise (ChirpStack) uplink path:**
1. LoRaWAN gateway → `chirpstack-gateway-bridge` (UDP:1700)
2. Bridge publishes to Mosquitto: `eu868/gateway/{gwID}/event/up`
3. ChirpStack processes MAC layer, decrypts payload
4. ChirpStack publishes to Mosquitto: `application/{appID}/device/{devEUI}/event/up`
5. Backend `mqttClient.js` receives; ChirpStack adapter normalizes → `mqtt/things/{devEUI}/uplink` with `DevEUI_uplink` envelope (hex payload)
6. WaveformManager, FUOTAManager, MessageTracker, Socket.io process the canonical message

**ThingPark uplink path:**
1. LoRaWAN gateway → Actility ThingPark cloud (decrypts payload)
2. ThingPark publishes `DevEUI_uplink` JSON to customer MQTT endpoint
3. Backend `mqttClient.js` connects to `MQTT_BROKER_URL`; ThingPark adapter is a passthrough (already canonical format)
4. Same downstream processing as ChirpStack path

**Downlink path:**
- Frontend → Socket.io `publish` → `mqttClient.publish` → active adapter translates → Mosquitto/ThingPark
- ChirpStack adapter: converts `mqtt/things/{devEUI}/downlink` → `application/{appID}/device/{devEUI}/command/down` (base64 payload)
- ThingPark adapter: passthrough — publishes `DevEUI_downlink` JSON on `mqtt/things/{devEUI}/downlink`

### Backend modules (`backend/src/`)
- **index.js**: Express server, Socket.io setup, PKI initialization, REST endpoints. Uses `ChirpStackClient` for network-server status (`/api/fuota/network-server-status`).
- **mqttClient.js**: MQTT broker connection. Selects adapter at startup from `NETWORK_SERVER` env var. Logs `"MQTT adapter: chirpstack|thingpark"` on startup. Runs every incoming message through the adapter before dispatching; translates outgoing downlinks via adapter before publishing.
- **adapters/chirpstack.js**: Bidirectional format adapter. `normalizeIncoming`: converts `application/+/device/+/event/up` (base64) → `mqtt/things/{devEUI}/uplink` (`DevEUI_uplink` hex). `normalizeOutgoing`: converts internal downlink → ChirpStack command format. Passes through unrecognised topics unchanged.
- **adapters/thingpark.js**: Identity passthrough adapter. Both `normalizeIncoming` and `normalizeOutgoing` return their inputs unchanged. ThingPark already publishes/expects canonical format.
- **services/ChirpStackClient.js**: Calls ChirpStack REST API (`/api/devices/{devEUI}`) with API-key auth to switch device class A↔C for FUOTA. Gracefully no-ops when `CHIRPSTACK_API_KEY` is absent (covers ThingPark and unauthenticated scenarios).
- **services/FUOTAManager.js**: FUOTA firmware update state machine. Uses ChirpStackClient for Class C switching (no-op in ThingPark mode — manual switch required).
- **services/DemoSimulator.js**: Dual-mode demo. In ChirpStack mode emits `buildChirpStackUplink()` to ChirpStack topics so they flow through the full adapter pipeline. In ThingPark mode emits `buildThingParkUplink()` directly to canonical topics.
- **pki.js**: X.509 certificate generation via OpenSSL (CA, server cert for Mosquitto TLS, client certs for download).
- **db.js**: PostgreSQL connection pool (host: `postgres`, db: `airvibe`) with retry logic and schema initialization.
- **services/WaveformManager.js**: Processes AirVibe waveform packets (TWIU 0x03, TWD 0x01, TWF 0x05), assembles segments, handles missing segment requests.
- **services/MessageTracker.js**: Persists messages to DB, upserts device registry. Expects internal canonical topic format `mqtt/things/{devEUI}/uplink|downlink`.

### Frontend structure (`frontend/src/`)
- **app/page.tsx**: Main UI with tabs — MQTT Monitor, Waveform Manager, FUOTA Manager, Certificate Management
- **app/SocketContext.tsx**: Socket.io context provider managing connection state and message buffer (last 500 messages)
- **components/MQTTMessageCard.tsx**: Collapsible message cards with JSON pretty-printing
- **components/FUOTAManager.tsx**: FUOTA UI. Shows ChirpStack/ThingPark-conditional Class C status banner. Fetches `/api/fuota/network-server-status`.

### ChirpStack configuration (`chirpstack/`)
Only loaded when `COMPOSE_PROFILES=full`.
- **chirpstack.toml**: Main server config (PostgreSQL DSN, Redis, API bind, MQTT integration, enabled regions)
- **chirpstack-gateway-bridge.toml**: Gateway bridge config (UDP backend, MQTT output, region topic prefix)
- **region_eu868.toml**: EU868 channel plan (8 x 125 kHz + FSK channels)
- **region_us915.toml**: US915 sub-band 2 channel plan

### AirVibe waveform protocol
Messages arrive at the backend already in canonical format (hex payload in `DevEUI_uplink.payload_hex`). Key packet types:
- `0x03` TWIU: Waveform metadata (segment count, sample rate, axis config)
- `0x01` TWD: Data segment with 16-bit index
- `0x05` TWF: Final segment marker
- `0x02` REQ: Request missing segments (fPort 21)

Downlink commands target fPorts 20-22, 25, 30-31 with hex payloads. The adapter handles base64/hex conversion transparently.

## Key Conventions

- **`NETWORK_SERVER`**: `chirpstack` (default) or `thingpark`. Read at module-load time in `mqttClient.js` and `DemoSimulator.js`. Drives adapter selection and Caddyfile TLS mode.
- **Internal canonical topic format**: All business logic uses `mqtt/things/{devEUI}/uplink|downlink` — the adapter translates to/from network-server-specific format at the MQTT client boundary.
- **`caddy/entrypoint.sh`**: Shell script that generates `/etc/caddy/Caddyfile` at container start from `DOMAIN` and `NETWORK_SERVER`, then execs Caddy. ChirpStack/localhost → `tls internal`. ThingPark + real domain → automatic ACME. No static Caddyfile is tracked in git.
- **`NEXT_PUBLIC_API_URL` bake-in**: Compiled into the Next.js bundle at `docker compose build` time. Changing it requires a rebuild, not just a restart.
- **Path alias**: Frontend uses `@/*` → `./src/*` (configured in tsconfig.json)
- **React Compiler** is enabled in next.config.ts for automatic memoization
- **Dark theme**: UI uses VS Code-like dark color scheme (#1e1e1e backgrounds)
- **Certificates** are stored in `./certs/` volume shared between backend and Mosquitto
- **mosquitto/watcher.sh**: Watchdog that monitors cert file changes and auto-restarts the broker

## Decision-Making Process

Before implementing any feature or change the user asks for, always:

1. Consider a minimum of **3 alternative approaches** to the problem
2. Compare each alternative against the original ask on: cleanliness, performance, long-term maintainability, and risk of painting ourselves into a corner
3. If any alternative is clearly better (cleaner, more performant, better senior-developer-style decision), **push for that approach over the original ask** — explain why and let the user decide
4. Prefer solutions that avoid unnecessary overhead, schema bloat, or coupling that would make future changes harder

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs `docker compose build` on pushes/PRs to `main`.
