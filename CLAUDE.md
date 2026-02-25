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
./deploy.sh                          # Pull pre-built images from ghcr.io and restart (VPS, fast — preferred)
./build.sh                           # Build images locally and start (local dev or first-time VPS setup)
docker compose up -d --build backend # Rebuild backend only (no frontend bake-in needed)
docker compose restart mqtt-broker   # Restart broker (e.g. after cert changes)
docker compose logs -f chirpstack    # Watch ChirpStack startup (full profile)
```

**On the VPS, use `./deploy.sh`.** GitHub Actions builds and pushes pre-built images to ghcr.io on every push to `main`. `deploy.sh` does `git pull → docker compose pull → docker compose up -d` — no compiler on the VPS, completes in seconds.

**For local dev or first-time VPS setup, use `./build.sh`.** It runs `git pull`, exports `NEXT_PUBLIC_BUILD_HASH` (current git short SHA) and `NEXT_PUBLIC_BUILD_DATE` (UTC timestamp), then calls `docker compose up -d --build`. Running `docker compose up -d --build` directly leaves the footer showing `build unknown • unknown`.

**GitHub Actions secret required:** The CI workflow bakes `NEXT_PUBLIC_API_URL` into the frontend image at build time. Add `NEXT_PUBLIC_API_URL` as a repository secret in GitHub → Settings → Secrets and variables → Actions. Set it to the public URL of your deployment (e.g. `https://air.machinesaver.com`). Without this secret the CI build falls back to `https://localhost`, which only works for local deployments.

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
- **index.js**: Express server, Socket.io setup, PKI initialization, REST endpoints. Uses `networkServerClient` for network-server status (`/api/fuota/network-server-status`) — returns `{ configured, type }`. `/api/health` performs three live checks (Postgres `SELECT 1`, MQTT `isConnected()`, FUOTA active session count) and returns 200/503 accordingly.
- **mqttClient.js**: MQTT broker connection. Selects adapter at startup from `NETWORK_SERVER` env var. Logs `"MQTT adapter: chirpstack|thingpark"` on startup. Runs every incoming message through the adapter before dispatching; translates outgoing downlinks via adapter before publishing. Exports `isConnected()` boolean for health checks and FUOTA MQTT-pause logic.
- **adapters/chirpstack.js**: Bidirectional format adapter. `normalizeIncoming`: converts `application/+/device/+/event/up` (base64) → `mqtt/things/{devEUI}/uplink` (`DevEUI_uplink` hex). `normalizeOutgoing`: converts internal downlink → ChirpStack command format. Passes through unrecognised topics unchanged.
- **adapters/thingpark.js**: Identity passthrough adapter. Both `normalizeIncoming` and `normalizeOutgoing` return their inputs unchanged. ThingPark already publishes/expects canonical format.
- **services/networkServerClient.js**: Unified Class C switching selector. Reads `NETWORK_SERVER` at module-load time and exports either a ChirpStackClient or ThingParkClient wrapper with a consistent interface (`configured`, `type`, `switchToClassC`, `restoreClass`). All FUOTA code routes through this module — never imports ChirpStackClient or ThingParkClient directly.
- **services/ChirpStackClient.js**: Calls ChirpStack REST API (`/api/devices/{devEUI}`) with API-key auth to switch device class A↔C for FUOTA. Gracefully no-ops when `CHIRPSTACK_API_KEY` is absent.
- **services/ThingParkClient.js**: Calls ThingPark DX Core API with OAuth2 client-credentials to switch device profile A→C for FUOTA. Caches token and retries on 401. Gracefully no-ops when `THINGPARK_CLIENT_ID`/`THINGPARK_CLIENT_SECRET` are absent.
- **services/FUOTAManager.js**: FUOTA firmware update state machine. Uses `networkServerClient` for Class C switching — automatic in both ChirpStack and ThingPark modes when credentials are configured; graceful no-op otherwise (manual switch required). Key reliability behaviours: (1) `_restoreClassWithRetry` retries Class A restore up to 3 times (15 s / 30 s backoff) as a non-blocking fire-and-forget so terminal state handlers are never delayed; (2) `_waitForMqtt` polls `isConnected()` every 5 s at the top of the block-send and resend loops — pauses until reconnected or `FUOTA_MQTT_WAIT_MS` elapses, then fails the session; (3) `_emitProgress` includes `startedAt` timestamp so the UI can compute an observed-rate ETA; (4) `startSession` upserts the device row before the session INSERT to satisfy the FK constraint on `fuota_sessions.device_eui`.
- **services/ApiKeyManager.js**: API key lifecycle management. `hashKey(rawKey)` → SHA-256 hex. `generateRawKey()` → `airvibe_` + 32 random bytes (64 hex chars). `createKey(label)` stores the hash and returns the raw key once. `bootstrapKey(rawKey, label)` inserts a known key idempotently (`ON CONFLICT DO NOTHING`). `validateKey(rawKey)` queries by hash, fire-and-forgets a `last_used_at` UPDATE, returns null if not found. `listKeys()` returns id/label/created_at/last_used_at (never key_hash). `revokeKey(id)` returns boolean.
- **middleware/auth.js**: Exports `requireApiKey` — Bearer API key middleware. No-op when `API_KEYS_ENABLED !== "true"`. Exempt paths: `'/'`, `'/api/health'`, `'/api/openapi.json'`, and any path starting with `'/api/docs'`. Returns 401 for missing/malformed Authorization header or unrecognised key. Sets `req.apiKey` on success. Network-server-agnostic (works in both ChirpStack and ThingPark modes).
- **openapi.js**: Full OpenAPI 3.1 specification exported as a plain JS object. Served at `GET /api/openapi.json` (raw JSON) and `GET /api/docs/` (Swagger UI via `swagger-ui-express@^4`). Both paths are auth-exempt. Covers all 28 REST endpoints with schemas, parameters, and response definitions. A static copy is kept at `openapi.json` in the repo root — regenerate with `node backend/scripts/export-openapi.js` after any spec change.
- **`POST /api/fuota/upload` — multer disk-storage**: Accepts `multipart/form-data` with a `firmware` field (binary, max 10 MB). Multer writes the file to `os.tmpdir()`; the route handler reads it into a `Buffer`, validates the filename (`^[a-zA-Z0-9._\-\s]+$`, max 255 chars, no path separators), passes it to `fuotaManager.storeFirmware(name, buf)`, then deletes the temp file. Returns 400 for missing/empty file or invalid filename, 413 for files > 10 MB.
- **services/AuditLogger.js**: Persists audit events to the `audit_log` DB table. Called by most modules with `(source, action, deviceEui, details)`.
- **services/DemoSimulator.js**: Dual-mode demo. In ChirpStack mode emits `buildChirpStackUplink()` to ChirpStack topics so they flow through the full adapter pipeline. In ThingPark mode emits `buildThingParkUplink()` directly to canonical topics.
- **pki.js**: X.509 certificate generation via OpenSSL (CA, server cert for Mosquitto TLS, client certs for download).
- **db.js**: PostgreSQL connection pool (host: `postgres`, db: `airvibe`) with retry logic and schema initialization.
- **services/WaveformManager.js**: Processes AirVibe waveform packets (TWIU 0x03, TWD 0x01, TWF 0x05), assembles segments, handles missing segment requests. Assembled waveforms are stored as raw `BYTEA` in `final_data_bytes` (halves storage vs JSONB hex); old rows with `final_data` JSONB are handled via fallback in read endpoints. `startCleanupJob` runs every 5 min: marks stale `pending` rows (>30 min since last update) as `failed`, then purges `failed`/`aborted` rows older than `WAVEFORMS_FAILED_TTL_DAYS` days (default 7) with cascade-delete of segments. `_scheduleRepairTimeout` sets a 5-minute per-waveform timeout after issuing a missing-segment request batch; on fire it re-runs `checkCompletion` to re-request if the batch is still outstanding.
- **services/MessageTracker.js**: Persists messages to DB, upserts device registry. Expects internal canonical topic format `mqtt/things/{devEUI}/uplink|downlink`. Runs a nightly retention DELETE controlled by `MESSAGES_MAX_AGE_DAYS` (default 90 days; `timer.unref()` so it never blocks process exit during tests).
- **utils/deinterleave.js**: Splits a multi-axis waveform hex payload into per-axis arrays (`axis1`, `axis2`, `axis3`) based on the axis-mask byte from the TWIU header. Used by `index.js` REST waveform endpoints.

### Frontend structure (`frontend/src/`)
- **app/page.tsx**: Main UI with 6 sidebar views — MQTT Monitor, Waveform Manager, FUOTA Manager, Dev Tools, Historian, API Documentation (iframe to `${NEXT_PUBLIC_API_URL}/api/docs/`)
- **app/SocketContext.tsx**: Socket.io context provider managing connection state and message buffer (last 500 messages)
- **components/MQTTMonitor.tsx**: Live MQTT message feed. Props: `{ messages, socket }`. Embeds `<DownlinkBuilder>` (collapsed by default) between the stats banner and the message stream. Includes a stream controls row: DevEUI text filter, direction dropdown (All/Uplink/Downlink), Collapse All / Expand All buttons. Scroll anchor via `useLayoutEffect` preserves reading position when new messages arrive.
- **components/MQTTMessageCard.tsx**: Collapsible message cards with JSON pretty-printing. Accepts `collapseKey` and `expandKey` numeric props — incrementing either forces all cards to collapse or expand (uses React setState-during-render pattern, not `useEffect`).
- **components/WaveformsView.tsx**: Waveform management tab. Renders assembled waveforms per device using `SegmentMap`, `WaveformChart`, and `WaveformTracker` sub-components. Detail header shows start time as the primary heading; Tx# and DevEUI as subtitle; metadata as inline badges with per-axis ✓/✗ indicators.
- **components/SegmentMap.tsx**: Visual grid showing received/missing/requested waveform segments.
- **components/WaveformChart.tsx**: Time-series chart rendering decoded axis data.
- **components/WaveformTracker.tsx**: Client-side waveform packet decoder/assembler with hex input, segment map, SVG plot, and CSV export. Accessed via Dev Tools → Waveform Tracker.
- **components/FUOTAManager.tsx**: FUOTA UI. Shows network-server-conditional Class C status banner (4 variants: ChirpStack/ThingPark × configured/not-configured). Fetches `/api/fuota/network-server-status` for `{ configured, type }`.
- **components/DownlinkBuilder.tsx**: Manual downlink composer with command presets from `lib/commandPresets.ts`. All four cards (Broker Connection, MQTT Message, Payload Preview, Mosquitto Pub Command) are collapsible, defaulting to collapsed. All card titles are `text-orange-500`. Embedded inside `MQTTMonitor` — not rendered separately in `page.tsx`.
- **components/CertificateManager.tsx**: Certificate download UI for MQTT TLS client certs. Accessed via Dev Tools → Certificates.
- **components/DevTools.tsx**: Tab with three sub-tabs — Sensor Simulator, Waveform Tracker, Certificates. Renders `SensorSimulator`, `WaveformTracker`, or `CertificateManager` based on the active sub-tab.
- **components/Historian.tsx**: Server-side message history search. Form with DevEUI, direction, date-range inputs; fetches `GET /api/messages`; renders paginated results table. Uses `X-Total-Count` response header for total count.
- **components/SensorSimulator.tsx**: Demo simulator card (start/stop/reset, duration picker, progress bar, log). Standalone component — no props needed. Used inside `DevTools`.
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
- **`final_data_bytes` BYTEA migration**: New waveform rows write raw binary to `final_data_bytes` and `NULL` to `final_data`. Read endpoints (download, CSV, detail) use the pattern `waveform.final_data_bytes?.toString('hex') ?? waveform.final_data?.raw_hex` to handle both old JSONB and new BYTEA rows. The schema column was added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (idempotent).
- **`fuota_sessions` FK constraint**: Added as `NOT VALID` (skips historical row scan) via a DO-block in `schema.sql`. `FUOTAManager.startSession` upserts the device row (`INSERT ... ON CONFLICT DO NOTHING`) before the session INSERT to satisfy the constraint for previously-unseen devices.
- **Configurable operational env vars**: `MESSAGES_MAX_AGE_DAYS` (default 90) — message table retention; `WAVEFORMS_FAILED_TTL_DAYS` (default 7) — failed/aborted waveform purge TTL; `FUOTA_MQTT_WAIT_MS` (default 300000) — FUOTA MQTT disconnect tolerance before session failure. All three are wired in `docker-compose.yml` and read at runtime (not build time).
- **`API_KEYS_ENABLED` / `BOOTSTRAP_API_KEY`**: Set `API_KEYS_ENABLED=true` to enforce Bearer auth on all endpoints except `'/'`, `'/api/health'`, `'/api/openapi.json'`, and paths under `'/api/docs'`. Set `BOOTSTRAP_API_KEY` to a known `airvibe_…` key so the first operator can authenticate before creating keys via the API (chicken-and-egg bootstrap). The key is inserted idempotently at startup — safe to leave set permanently. Key management endpoints: `POST /api/keys` (201 + raw key shown once), `GET /api/keys` (list metadata), `DELETE /api/keys/:id` (204/404).

## Development Approach — Red / Green / Refactor (TDD)

**This is the mandatory development workflow for all non-trivial backend changes.**

1. **Red** — Write a failing test that precisely describes the intended behaviour *before writing any implementation code*. Run `npm test` and confirm the new test(s) fail. A "Cannot find module" error counts as red when the module does not yet exist.
2. **Green** — Write the minimum implementation needed to make the failing test(s) pass. Run `npm test` and confirm all tests pass (new and pre-existing). Iterate until green.
3. **Refactor** — Improve the code's structure, readability, and modularity without changing its observable behaviour. Extract helpers, remove duplication, align with existing patterns. Run `npm test` again — all tests must remain green.

**Rules:**
- Never write implementation code before a failing test exists for it.
- Never commit code that leaves any test red.
- The test must fail for the *right reason* (assertion failure or missing module), not due to a misconfigured mock or unrelated error.
- Refactoring must not add new behaviour — new behaviour always starts a new red→green cycle.
- This applies to all new REST endpoints, service methods, and utilities. Minor one-liner fixes (typo, obvious safe rename) may skip the cycle but must not break existing tests.

**Test infrastructure:**
- Unit tests (service logic): `backend/test/waveform.test.js`, `backend/test/adapter.test.js` — mock `pool` and all singletons, use `jest.useFakeTimers()` when setInterval is involved.
- API integration tests: `backend/test/api.test.js` — mock all service singletons, use `supertest` against `require('../src/app').app`.
- `src/app.js` exports `{ app, server, io }` (routes + middleware, no startup side effects). `src/index.js` is the entry point only (DB connect, MQTT connect, PKI init, `server.listen()`). Tests always import from `app.js`, never `index.js`.

## Decision-Making Process

Before implementing any feature or change the user asks for, always:

1. Consider a minimum of **3 alternative approaches** to the problem
2. Compare each alternative against the original ask on: cleanliness, performance, long-term maintainability, and risk of painting ourselves into a corner
3. If any alternative is clearly better (cleaner, more performant, better senior-developer-style decision), **push for that approach over the original ask** — explain why and let the user decide
4. Prefer solutions that avoid unnecessary overhead, schema bloat, or coupling that would make future changes harder

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs `docker compose build` on pushes/PRs to `main`.

## VPS Deployment — Lessons Learned

### VPS specs and constraints
The production VPS (air.machinesaver.com, Linode) has **1 GB RAM**. The Next.js Turbopack production build requires ~3–4 GB memory. A **4 GB swap file** at `/swapfile` is required and is already configured. Without it, the Node.js build process is OOM-killed mid-compile.

Verify swap is active before any frontend rebuild:
```bash
free -h    # Swap line should show ~4.5 GiB total
```

If swap is missing (e.g. after a fresh VPS provision):
```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Normal VPS deploy: use `./deploy.sh`
`deploy.sh` runs `git pull`, then `docker compose pull frontend backend` (fetches pre-built images from ghcr.io), then `docker compose up -d`. Completes in seconds. No build tools or swap needed. This is the correct deploy path once GitHub Actions CI is pushing images.

### Fallback: `./build.sh` for local builds on the VPS
Only needed if CI is broken, the ghcr.io images are unavailable, or you're on a fresh VPS before CI has pushed any images. `build.sh` runs `git pull`, exports build metadata, then calls `docker compose up -d --build`. **Requires 4 GB swap — see above.** Running `docker compose up -d --build` directly (without `build.sh`) will build from whatever code is checked out and leave the footer showing `build unknown • unknown`.

### Docker layer cache pitfall — when to use `--no-cache`
Under normal circumstances `./build.sh` is sufficient; Docker will invalidate the `COPY . .` layer when source files change. Only reach for `--no-cache` if the image is provably stale despite a clean `git pull`. **`--no-cache` is very expensive on a 1 GB VPS** — it bypasses the `.next/cache` BuildKit mount and forces a full Turbopack cold compile (~30 min). The `NODE_OPTIONS=--max-old-space-size=3072` in `frontend/Dockerfile` caps Node's heap at 3 GB so it spills to swap gracefully rather than trying to claim unlimited memory.

### Never start a second build if the first is still running
Docker builds continue running on the server even after an SSH connection is dropped. If a build appears to hang and the SSH pipe breaks, **do not start another build immediately**. Check for running processes first:
```bash
docker ps    # look for a build container
ps aux | grep node    # look for a live node/next build process
```
Starting multiple concurrent `next build` processes on a 1 GB machine will compound memory pressure, escalate to OOM-killing critical system processes (including `systemd`), and can crash the VPS entirely — requiring a hard reboot from the Linode dashboard.

### Recovery procedure after OOM crash
1. Reboot from the Linode dashboard (SSH will be unresponsive — `Connection reset by peer`)
2. Confirm SSH access is restored
3. Verify swap is still active (`free -h`)
4. Pull and rebuild: `cd /root/mqtt-manager && ./build.sh`

### VPS path
The project lives at `/root/mqtt-manager` on the VPS (not `/root/AirVibe_Waveform_Manager`).
