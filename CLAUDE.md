# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AirVibe Waveform Manager (**on_premise** branch) is a fully self-contained Docker-based platform for managing AirVibe vibration sensors over LoRaWAN — no cloud network server required. It bundles ChirpStack v4 (open-source LoRaWAN Network + Application Server) alongside the existing MQTT monitoring, waveform management, FUOTA firmware update, and PKI certificate management features.

## Build & Run Commands

### Docker (primary method)
```bash
cp .env.example .env
docker compose up -d --build        # Start entire stack (8 services)
docker compose restart mqtt-broker   # Restart broker (e.g. after cert changes)
docker compose logs -f chirpstack    # Watch ChirpStack startup
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

### No test framework is configured.

## Architecture

### Services (docker-compose.yml)
- **chirpstack-gateway-bridge** (port 1700/UDP): Accepts Semtech UDP Packet Forwarder connections from LoRaWAN gateways, translates to MQTT, and forwards to Mosquitto.
- **chirpstack** (port 8080): Open-source LoRaWAN Network Server + Application Server. Handles MAC layer, ADR, join procedure, payload decryption, and publishes decoded uplinks to Mosquitto.
- **redis** (internal): Required by ChirpStack for device session state and downlink queuing.
- **Caddy** (ports 80/443): Reverse proxy with `tls internal` (LAN-safe self-signed cert, no Let's Encrypt). Routes `/api/*` and `/socket.io/*` to backend, everything else to frontend.
- **Backend** (port 4000): Express server with Socket.io and MQTT client. Includes ChirpStack adapter layer.
- **Frontend** (port 3000): Next.js 16 with React 19, TypeScript, Tailwind CSS 4.
- **Mosquitto** (ports 1883/8883): MQTT broker with optional TLS. Shared between ChirpStack and the application backend.
- **postgres** (internal): PostgreSQL 16. Hosts both the `airvibe` database (application data) and the `chirpstack` database (ChirpStack schema).

### Real-time data flow
1. LoRaWAN gateway sends frames to `chirpstack-gateway-bridge` (UDP:1700)
2. Bridge publishes to Mosquitto: `eu868/gateway/{gwID}/event/up`
3. ChirpStack subscribes to gateway topics, processes MAC layer, decrypts payload
4. ChirpStack publishes decoded uplink to Mosquitto: `application/{appID}/device/{devEUI}/event/up`
5. Backend (`mqttClient.js`) subscribes to `#` and runs each message through `adapters/chirpstack.js`
6. Adapter normalizes ChirpStack uplinks → internal format (`mqtt/things/{devEUI}/uplink` + `DevEUI_uplink` envelope)
7. Normalized messages dispatched to MessageTracker, WaveformManager, FUOTAManager, and Socket.io
8. Frontend receives via Socket.io `mqtt:message` events and renders in MQTT Monitor / Waveform / FUOTA tabs
9. Downlinks: frontend → Socket.io `publish` → mqttClient.publish → adapter translates to ChirpStack command format → Mosquitto → ChirpStack → gateway → device

### Backend modules (`backend/src/`)
- **index.js**: Express server, Socket.io setup, PKI initialization, REST endpoints. Uses `ChirpStackClient` for network-server status (`/api/fuota/network-server-status`).
- **mqttClient.js**: MQTT broker connection. Runs every incoming message through the ChirpStack adapter before dispatching. Translates outgoing downlinks via adapter before publishing.
- **adapters/chirpstack.js**: Bidirectional format adapter. Normalizes `application/+/device/+/event/up` → `mqtt/things/{devEUI}/uplink` with `DevEUI_uplink` envelope (hex payload). Translates `mqtt/things/{devEUI}/downlink` → `application/{appID}/device/{devEUI}/command/down` with base64 payload.
- **services/ChirpStackClient.js**: Replaces ThingParkClient. Calls ChirpStack REST API (`/api/devices/{devEUI}`) with API-key auth to switch device class A↔C for FUOTA. Gracefully no-ops when `CHIRPSTACK_API_KEY` not set.
- **services/FUOTAManager.js**: FUOTA firmware update state machine. Uses ChirpStackClient for Class C switching.
- **pki.js**: X.509 certificate generation via OpenSSL (CA, server cert for Mosquitto TLS, client certs for download).
- **db.js**: PostgreSQL connection pool (host: `postgres`, db: `airvibe`) with retry logic and schema initialization.
- **services/WaveformManager.js**: Processes AirVibe waveform packets (TWIU 0x03, TWD 0x01, TWF 0x05), assembles segments, handles missing segment requests.
- **services/MessageTracker.js**: Persists messages to DB, upserts device registry. Expects internal canonical topic format `mqtt/things/{devEUI}/uplink|downlink`.
- **services/DemoSimulator.js**: Demo mode simulator. Emits ChirpStack-format uplinks to ChirpStack-format topics so they flow through the full adapter pipeline.

### Frontend structure (`frontend/src/`)
- **app/page.tsx**: Main UI with tabs — MQTT Monitor, Waveform Manager, FUOTA Manager, Certificate Management
- **app/SocketContext.tsx**: Socket.io context provider managing connection state and message buffer (last 500 messages)
- **components/MQTTMessageCard.tsx**: Collapsible message cards with JSON pretty-printing
- **components/FUOTAManager.tsx**: FUOTA UI. References `ChirpStack` (not ThingPark) for Class C status. Fetches `/api/fuota/network-server-status`.

### ChirpStack configuration (`chirpstack/`)
- **chirpstack.toml**: Main server config (PostgreSQL DSN, Redis, API bind, MQTT integration, enabled regions)
- **chirpstack-gateway-bridge.toml**: Gateway bridge config (UDP backend, MQTT output, region topic prefix)
- **region_eu868.toml**: EU868 channel plan (8 x 125 kHz + FSK channels)
- **region_us915.toml**: US915 sub-band 2 channel plan

### AirVibe waveform protocol
Messages arrive at backend already normalized (hex payload in `DevEUI_uplink.payload_hex`). Key packet types:
- `0x03` TWIU: Waveform metadata (segment count, sample rate, axis config)
- `0x01` TWD: Data segment with 16-bit index
- `0x05` TWF: Final segment marker
- `0x02` REQ: Request missing segments (fPort 21)

Downlink commands target specific fPorts (20-22, 25, 30-31) with hex payloads. The adapter handles base64/hex conversion transparently.

## Key Conventions

- **Path alias**: Frontend uses `@/*` → `./src/*` (configured in tsconfig.json)
- **React Compiler** is enabled in next.config.ts for automatic memoization
- **Dark theme**: UI uses VS Code-like dark color scheme (#1e1e1e backgrounds)
- **Environment variables**: `DOMAIN`, `MQTT_BROKER_URL`, `NEXT_PUBLIC_API_URL`, Postgres config vars, `CHIRPSTACK_API_URL`, `CHIRPSTACK_API_KEY`, `CHIRPSTACK_APPLICATION_ID`
- **Certificates** are stored in `./certs/` volume shared between backend and Mosquitto
- **mosquitto/watcher.sh**: Watchdog that monitors cert file changes and auto-restarts the broker
- **Internal canonical topic format**: All business logic uses `mqtt/things/{devEUI}/uplink|downlink` — the adapter translates to/from ChirpStack format at the MQTT client boundary

## Decision-Making Process

Before implementing any feature or change the user asks for, always:

1. Consider a minimum of **3 alternative approaches** to the problem
2. Compare each alternative against the original ask on: cleanliness, performance, long-term maintainability, and risk of painting ourselves into a corner
3. If any alternative is clearly better (cleaner, more performant, better senior-developer-style decision), **push for that approach over the original ask** — explain why and let the user decide
4. Prefer solutions that avoid unnecessary overhead, schema bloat, or coupling that would make future changes harder

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs `docker compose build` on pushes/PRs to `main`.
