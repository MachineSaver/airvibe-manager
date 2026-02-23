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
./build.sh                           # Build and start the full stack (preferred over docker compose up -d --build directly)
docker compose up -d --build backend # Rebuild backend only (no frontend bake-in needed)
docker compose restart mqtt-broker   # Restart broker (e.g. after cert changes)
docker compose logs -f chirpstack    # Watch ChirpStack startup (full profile)
```

**Always use `./build.sh` for full-stack builds.** It exports `NEXT_PUBLIC_BUILD_HASH` (current git short SHA) and `NEXT_PUBLIC_BUILD_DATE` (UTC timestamp) before calling `docker compose up -d --build`, so those values are baked into the Next.js bundle and displayed in the UI footer (`build <hash> • <date>`). Running `docker compose up -d --build` directly leaves the footer showing `build unknown • unknown`.

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
2. ThingPark MQTT connector (configured in ThingPark X IoT Flow) connects TO the AirVibe Mosquitto broker on port 8883 using mTLS certificates from the Certificate Manager
3. ThingPark publishes `DevEUI_uplink` JSON to Mosquitto on topic `mqtt/things/{devEUI}/uplink`
4. Backend `mqttClient.js` is subscribed to `#` on the internal Mosquitto (port 1883); ThingPark adapter is a passthrough (already canonical format)
5. Same downstream processing as ChirpStack path

**Downlink path:**
- Frontend → Socket.io `publish` → `mqttClient.publish` → active adapter translates → Mosquitto
- ChirpStack adapter: converts `mqtt/things/{devEUI}/downlink` → `application/{appID}/device/{devEUI}/command/down` (base64 payload)
- ThingPark adapter: passthrough — publishes `DevEUI_downlink` JSON on `mqtt/things/{devEUI}/downlink`; ThingPark connector picks it up from Mosquitto and delivers to the device

### Backend modules (`backend/src/`)
- **index.js**: Express server, Socket.io setup, PKI initialization, REST endpoints. Uses `networkServerClient` for network-server status (`/api/fuota/network-server-status`) — returns `{ configured, type }`.
- **mqttClient.js**: MQTT broker connection. Selects adapter at startup from `NETWORK_SERVER` env var. Logs `"MQTT adapter: chirpstack|thingpark"` on startup. Runs every incoming message through the adapter before dispatching; translates outgoing downlinks via adapter before publishing.
- **adapters/chirpstack.js**: Bidirectional format adapter. `normalizeIncoming`: converts `application/+/device/+/event/up` (base64) → `mqtt/things/{devEUI}/uplink` (`DevEUI_uplink` hex). `normalizeOutgoing`: converts internal downlink → ChirpStack command format. Passes through unrecognised topics unchanged.
- **adapters/thingpark.js**: Identity passthrough adapter. Both `normalizeIncoming` and `normalizeOutgoing` return their inputs unchanged. ThingPark already publishes/expects canonical format.
- **services/networkServerClient.js**: Unified Class C switching selector. Reads `NETWORK_SERVER` at module-load time and exports either a ChirpStackClient or ThingParkClient wrapper with a consistent interface (`configured`, `type`, `switchToClassC`, `restoreClass`). All FUOTA code routes through this module — never imports ChirpStackClient or ThingParkClient directly.
- **services/ChirpStackClient.js**: Calls ChirpStack REST API (`/api/devices/{devEUI}`) with API-key auth to switch device class A↔C for FUOTA. Gracefully no-ops when `CHIRPSTACK_API_KEY` is absent.
- **services/ThingParkClient.js**: Calls ThingPark DX Core API with OAuth2 client-credentials to switch device profile A→C for FUOTA. Caches token and retries on 401. Gracefully no-ops when `THINGPARK_CLIENT_ID`/`THINGPARK_CLIENT_SECRET` are absent.
- **services/FUOTAManager.js**: FUOTA firmware update state machine. Uses `networkServerClient` for Class C switching — automatic in both ChirpStack and ThingPark modes when credentials are configured; graceful no-op otherwise (manual switch required).
- **services/AuditLogger.js**: Persists audit events to the `audit_log` DB table. Called by most modules with `(source, action, deviceEui, details)`.
- **services/DemoSimulator.js**: Dual-mode demo. In ChirpStack mode emits `buildChirpStackUplink()` to ChirpStack topics so they flow through the full adapter pipeline. In ThingPark mode emits `buildThingParkUplink()` directly to canonical topics.
- **pki.js**: X.509 certificate generation via OpenSSL (CA, server cert for Mosquitto TLS, client certs for download).
- **db.js**: PostgreSQL connection pool (host: `postgres`, db: `airvibe`) with retry logic and schema initialization.
- **services/WaveformManager.js**: Processes AirVibe waveform packets (TWIU 0x03, TWD 0x01, TWF 0x05), assembles segments, handles missing segment requests.
- **services/MessageTracker.js**: Persists messages to DB, upserts device registry. Expects internal canonical topic format `mqtt/things/{devEUI}/uplink|downlink`.
- **utils/deinterleave.js**: Splits a multi-axis waveform hex payload into per-axis arrays (`axis1`, `axis2`, `axis3`) based on the axis-mask byte from the TWIU header. Used by `index.js` REST waveform endpoints.

### Frontend structure (`frontend/src/`)
- **app/page.tsx**: Main UI with tabs — MQTT Monitor, Waveform Manager, FUOTA Manager, Certificate Management
- **app/SocketContext.tsx**: Socket.io context provider managing connection state and message buffer (last 500 messages)
- **components/MQTTMonitor.tsx**: Live MQTT message feed with filtering and collapsible cards.
- **components/MQTTMessageCard.tsx**: Collapsible message cards with JSON pretty-printing.
- **components/WaveformsView.tsx**: Waveform management tab. Renders assembled waveforms per device using `SegmentMap`, `WaveformChart`, and `WaveformTracker` sub-components.
- **components/SegmentMap.tsx**: Visual grid showing received/missing/requested waveform segments.
- **components/WaveformChart.tsx**: Time-series chart rendering decoded axis data.
- **components/WaveformTracker.tsx**: Per-device waveform session state card.
- **components/FUOTAManager.tsx**: FUOTA UI. Shows network-server-conditional Class C status banner (4 variants: ChirpStack/ThingPark × configured/not-configured). Fetches `/api/fuota/network-server-status` for `{ configured, type }`.
- **components/DownlinkBuilder.tsx**: Manual downlink composer with command presets from `lib/commandPresets.ts`.
- **components/CertificateManager.tsx**: Certificate download UI for MQTT TLS client certs.
- **lib/commandPresets.ts**: Named downlink command presets (fPort + hex payload) for DownlinkBuilder.
- **utils/waveformTracker.ts**: Client-side waveform assembly state machine — tracks segments, detects completion, requests missing segments.

### ChirpStack configuration (`chirpstack/`)
Only loaded when `COMPOSE_PROFILES=full`.
- **chirpstack.toml**: Main server config (PostgreSQL DSN, Redis, API bind, MQTT integration, enabled regions)
- **chirpstack-gateway-bridge.toml**: Gateway bridge config (UDP backend, MQTT output, region topic prefix)
- **region_eu868.toml**: EU868 channel plan (8 x 125 kHz + FSK channels)
- **region_us915_0.toml**: US915 sub-band 2 channel plan

### AirVibe waveform protocol
Messages arrive at the backend already in canonical format (hex payload in `DevEUI_uplink.payload_hex`). Key packet types:
- `0x03` TWIU: Waveform metadata (segment count, sample rate, axis config)
- `0x01` TWD: Data segment with 16-bit index
- `0x05` TWF: Final segment marker
- `0x02` REQ: Request missing segments (fPort 21)

Downlink commands target fPorts 20-22, 25, 30-31 with hex payloads. The adapter handles base64/hex conversion transparently.

## Key Conventions

- **`NETWORK_SERVER`**: `chirpstack` (default) or `thingpark`. Read at module-load time in `mqttClient.js`, `DemoSimulator.js`, and `networkServerClient.js`. Drives adapter selection, Class C switching client selection, and Caddyfile TLS mode.
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
