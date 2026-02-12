# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AirVibe Waveform Manager is a Docker-based MQTT management platform for LoRaWAN IoT devices (AirVibe vibration sensors). It provides real-time MQTT monitoring, downlink command building, PKI certificate management, and waveform data collection/assembly.

## Build & Run Commands

### Docker (primary method)
```bash
cp .env.example .env
docker compose up -d --build        # Start entire stack
docker compose restart mqtt-broker   # Restart broker (e.g. after cert changes)
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
- **Caddy** (ports 80/443): Reverse proxy with auto-SSL. Routes `/api/*` and `/socket.io/*` to backend, everything else to frontend.
- **Backend** (port 4000): Express server with Socket.io and MQTT client.
- **Frontend** (port 3000): Next.js 16 with React 19, TypeScript, Tailwind CSS 4.
- **Mosquitto** (ports 1883/8883): MQTT broker with optional TLS.

### Real-time data flow
1. Mosquitto receives MQTT messages from IoT devices on topics like `mqtt/things/[DevEUI]/uplink`
2. Backend (`mqttClient.js`) subscribes to `#` (all topics) and relays messages to frontend via Socket.io `mqtt:message` events
3. Frontend receives messages through `SocketContext.tsx` (React context provider) and renders them in `MQTTMessageCard` components
4. Downlink commands flow in reverse: frontend → Socket.io `publish` event → backend → MQTT broker → `mqtt/things/[DevEUI]/downlink`

### Backend modules (`backend/src/`)
- **index.js**: Express server, Socket.io setup, PKI initialization, REST endpoints (`/api/certs/init`, `/api/certs/client`)
- **mqttClient.js**: MQTT broker connection, message relay to Socket.io, publish method
- **pki.js**: X.509 certificate generation via OpenSSL child processes (CA, server, client certs)
- **db.js**: PostgreSQL connection pool (host: `postgres`, db: `airvibe`) with retry logic and schema initialization
- **services/WaveformManager.js**: Processes AirVibe waveform packets (TWIU metadata 0x03, TWD data segments 0x01, TWF final segments 0x05), assembles segments, handles missing segment requests

### Frontend structure (`frontend/src/`)
- **app/page.tsx**: Main UI with two tabs — MQTT Monitor (message log + downlink builder with 20+ AirVibe command presets) and Certificate Management
- **app/SocketContext.tsx**: Socket.io context provider managing connection state and message buffer (last 500 messages)
- **components/MQTTMessageCard.tsx**: Collapsible message cards with JSON pretty-printing

### AirVibe waveform protocol
Messages use `payload_hex` in JSON. Key packet types:
- `0x03` TWIU: Waveform metadata (segment count, sample rate, axis config)
- `0x01` TWD: Data segment with 16-bit index
- `0x05` TWF: Final segment marker
- `0x02` REQ: Request missing segments (fPort 21)

Downlink commands target specific fPorts (20-22, 30-31) with hex payloads.

## Key Conventions

- **Path alias**: Frontend uses `@/*` → `./src/*` (configured in tsconfig.json)
- **React Compiler** is enabled in next.config.ts for automatic memoization
- **Dark theme**: UI uses VS Code-like dark color scheme (#1e1e1e backgrounds)
- **Environment variables**: `DOMAIN`, `MQTT_BROKER_URL` (default `mqtt://mqtt-broker:1883`), `NEXT_PUBLIC_API_URL`, Postgres config vars
- **Certificates** are stored in `./certs/` volume shared between backend and Mosquitto
- **mosquitto/watcher.sh**: Watchdog that monitors cert file changes and auto-restarts the broker

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs `docker compose build` on pushes/PRs to `main`.
