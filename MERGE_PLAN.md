# AirVibe Unified Network Server — Merge Plan

**Date:** 2026-02-23
**Branch:** `on_premise` (current HEAD — execute all phases here before fast-forwarding `main`)
**Goal:** Single codebase, two deployment modes, maximum automation — user sets env vars and runs `docker compose up`. No manual file editing beyond `.env`.

---

## 1. Two Deployment Modes

| | **Full / ChirpStack** | **App-only / ThingPark** |
|---|---|---|
| `NETWORK_SERVER` | `chirpstack` (default) | `thingpark` |
| `COMPOSE_PROFILES` | `full` | _(empty)_ |
| LoRaWAN network server | ChirpStack v4 in Docker | Actility ThingPark cloud |
| MQTT broker | Bundled Mosquitto in Docker | External (ThingPark endpoint) |
| `MQTT_BROKER_URL` | `mqtt://mqtt-broker:1883` (default) | ThingPark MQTT bridge URL |
| TLS | Caddy `tls internal` (LAN, no internet) | Caddy ACME (public domain) |
| `DOMAIN` | `localhost` (default) | `mqtt.yourcompany.com` |
| Docker services | All 8 | postgres + backend + frontend + caddy (4) |

**Zero-config ChirpStack experience:** `cp .env.example .env && docker compose up -d --build`  — the defaults work as-is.

**ThingPark experience:** Edit 4 lines in `.env` (`NETWORK_SERVER`, `COMPOSE_PROFILES`, `DOMAIN`, `MQTT_BROKER_URL`), then `docker compose up -d --build`.

---

## 2. How the Adapter Layer Works in Each Mode

The key insight: `adapters/chirpstack.js`'s `normalizeIncoming` already passes through any topic it doesn't recognise. ThingPark publishes to `mqtt/things/{devEUI}/uplink` (canonical format) — this doesn't match the ChirpStack regex so it passes through unchanged. **Uplinks already work in ThingPark mode with no adapter changes.**

The gap is **outgoing only**: `normalizeOutgoing` converts `mqtt/things/{devEUI}/downlink` → ChirpStack command format. In ThingPark mode this breaks downlinks — the backend would publish to `application/{id}/device/{devEUI}/command/down` but ThingPark expects the raw `DevEUI_downlink` JSON on the internal topic.

Fix: `adapters/thingpark.js` passthrough, loaded by `mqttClient.js` when `NETWORK_SERVER=thingpark`.

```
Uplink path:
  ThingPark → mqtt/things/{devEUI}/uplink (canonical) → chirpstack adapter passthrough → ✓
  ChirpStack → application/{id}/device/{devEUI}/event/up → adapter normalises → ✓

Downlink path:
  Backend → mqtt/things/{devEUI}/downlink
    chirpstack adapter → application/{id}/device/{devEUI}/command/down (base64) → ChirpStack ✓
    thingpark adapter  → mqtt/things/{devEUI}/downlink (passthrough, DevEUI_downlink JSON) → ThingPark ✓
```

---

## 3. File-by-File Changes

### 3.1 New files

#### `backend/src/adapters/thingpark.js`
Strict passthrough for both directions. Keeps `mqttClient.js`'s adapter interface consistent.

```js
function normalizeIncoming(topic, message) { return { topic, message }; }
function normalizeOutgoing(topic, message)  { return { topic, message }; }
module.exports = { normalizeIncoming, normalizeOutgoing };
```

---

#### `caddy/entrypoint.sh`
Replaces the static `Caddyfile` entirely. Generates the Caddyfile at container start from env vars, then execs Caddy. No manual Caddyfile management ever needed.

```sh
#!/bin/sh
set -e
DOMAIN="${DOMAIN:-localhost}"
NETWORK_SERVER="${NETWORK_SERVER:-chirpstack}"

# Use tls internal for on-premise/localhost; let Caddy do ACME for public domains
if [ "$NETWORK_SERVER" = "chirpstack" ] || [ "$DOMAIN" = "localhost" ]; then
    TLS_LINE="    tls internal"
else
    TLS_LINE="    # tls: automatic ACME via Let's Encrypt for ${DOMAIN}"
fi

cat > /etc/caddy/Caddyfile << EOF
${DOMAIN} {
${TLS_LINE}

    reverse_proxy /api/*       backend:4000
    reverse_proxy /socket.io/* backend:4000
    reverse_proxy /*           frontend:3000
}
EOF

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile "$@"
```

In `docker-compose.yml` the `caddy` service mounts this script instead of a static Caddyfile, and passes `NETWORK_SERVER` as an env var (it already passes `DOMAIN`).

> **Why this is better than two static Caddyfile variants:** The Caddyfile is generated at runtime — users never touch it. Adding a new reverse-proxy rule or adjusting TLS settings in the future means editing one template file, not two.

---

### 3.2 Modified files

#### `backend/src/mqttClient.js`
**One change:** replace the hard-coded adapter require with a runtime selection.

```js
// Replace:
const adapter = require('./adapters/chirpstack');

// With:
const NETWORK_SERVER = process.env.NETWORK_SERVER || 'chirpstack';
const adapter = NETWORK_SERVER === 'thingpark'
    ? require('./adapters/thingpark')
    : require('./adapters/chirpstack');
```

Add a startup log so operators can confirm which adapter loaded:
```js
console.log(`MQTT adapter: ${NETWORK_SERVER}`);
```

No other changes to this file.

---

#### `backend/src/services/DemoSimulator.js`
**One change:** `_publish()` must emit in the right format based on mode.

The current `buildChirpStackUplink()` publishes to `application/{appId}/device/{devEUI}/event/up` — this flows through the ChirpStack adapter and gets normalised. In ThingPark mode the adapter is a passthrough, so a ChirpStack-format message would arrive at WaveformManager un-decoded (ChirpStack JSON with base64 payload is not the canonical `DevEUI_uplink` format).

Add `buildThingParkUplink()` (identical to what `main`'s demo did) and select at runtime:

```js
function buildThingParkUplink(devEui, payloadHex, fPort = 8) {
    return {
        topic:   `mqtt/things/${devEui.toUpperCase()}/uplink`,
        message: JSON.stringify({
            DevEUI_uplink: {
                Time:        new Date().toISOString(),
                DevEUI:      devEui.toUpperCase(),
                FPort:       fPort,
                FCntUp:      Math.floor(Math.random() * 65535),
                payload_hex: payloadHex,
                LrrRSSI:     -80 - Math.floor(Math.random() * 30),
                LrrSNR:       5  + Math.floor(Math.random() * 10),
            },
        }),
    };
}
```

```js
// In _publish():
const NETWORK_SERVER = process.env.NETWORK_SERVER || 'chirpstack';
_publish(devEui, payloadHex, fPort = 8) {
    const { topic, message } = (NETWORK_SERVER === 'thingpark')
        ? buildThingParkUplink(devEui, payloadHex, fPort)
        : buildChirpStackUplink(devEui, payloadHex, fPort);
    mqttClient.publish(topic, message);
}
```

---

#### `backend/src/index.js`
**One change:** Remove the mode-conditional CORS logic. Always include `https://localhost`.

The current code on `on_premise` already includes `https://localhost` unconditionally. Leave it that way — no changes needed. Including `https://localhost` in CORS for a ThingPark deployment has no meaningful security implication.

> **No change required** — the current `on_premise` index.js CORS block is already correct for both modes.

---

#### `docker-compose.yml`
Five targeted changes:

**Change 1 — Add `NETWORK_SERVER` to the backend service environment:**
```yaml
- NETWORK_SERVER=${NETWORK_SERVER:-chirpstack}
```

**Change 2 — Replace the static Caddyfile mount with the entrypoint script:**
```yaml
caddy:
  image: caddy:alpine
  ...
  environment:
    - DOMAIN=${DOMAIN:-localhost}
    - NETWORK_SERVER=${NETWORK_SERVER:-chirpstack}   # ADD THIS
  volumes:
    - ./caddy/entrypoint.sh:/usr/local/bin/caddy-start.sh:ro   # REPLACE Caddyfile mount
    - caddy_data:/data
    - caddy_config:/config
  entrypoint: ["/bin/sh", "/usr/local/bin/caddy-start.sh"]     # ADD THIS
```

**Change 3 — Add `chirpstack-db-init` sidecar** (see Section 3.4 below).

**Change 4 — Make `chirpstack` depend on `chirpstack-db-init`:**
```yaml
chirpstack:
  depends_on:
    postgres:
      condition: service_healthy
    chirpstack-db-init:
      condition: service_completed_successfully   # ADD
    redis:
      condition: service_started
    mqtt-broker:
      condition: service_started
```

**Change 5 — Fix `NEXT_PUBLIC_API_URL` default:**
```yaml
# Change from:
- NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-http://localhost:4000}

# To (both build arg and runtime env):
- NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-https://localhost}
```
The default `http://localhost:4000` bypasses Caddy. In the `full` profile, Caddy is the correct entry point at `https://localhost`.

---

#### `.env.example`
Replace entirely with a unified template. The defaults must be valid for a zero-edit ChirpStack deployment:

```bash
# =============================================================================
# AirVibe Waveform Manager — Environment Configuration
# =============================================================================
# Copy: cp .env.example .env
#
# DEPLOYMENT MODES
# ─────────────────────────────────────────────────────────────────────────────
# ChirpStack (on-premise, default):
#   NETWORK_SERVER=chirpstack
#   COMPOSE_PROFILES=full
#   No other changes needed — docker compose up -d --build just works.
#
# Actility ThingPark (cloud):
#   NETWORK_SERVER=thingpark
#   COMPOSE_PROFILES=          (leave empty — cloud services not needed)
#   DOMAIN=mqtt.yourcompany.com
#   MQTT_BROKER_URL=mqtts://broker.thingpark.com:8883
#   NEXT_PUBLIC_API_URL=https://mqtt.yourcompany.com
# =============================================================================

# --- Deployment mode ---------------------------------------------------------
NETWORK_SERVER=chirpstack
COMPOSE_PROFILES=full

# --- Domain ------------------------------------------------------------------
# ChirpStack: keep as localhost (Caddy uses tls internal — no internet needed)
# ThingPark:  set to your public domain (Caddy uses ACME/Let's Encrypt)
DOMAIN=localhost

# --- Frontend API URL --------------------------------------------------------
# Must match the domain Caddy serves on. Baked into the Next.js build.
# ChirpStack: https://localhost
# ThingPark:  https://mqtt.yourcompany.com
NEXT_PUBLIC_API_URL=https://localhost

# --- MQTT broker -------------------------------------------------------------
# ChirpStack (full profile): leave as-is — uses bundled Mosquitto
# ThingPark: set to your ThingPark MQTT bridge URL
MQTT_BROKER_URL=mqtt://mqtt-broker:1883
# MQTT_USER=
# MQTT_PASS=

# --- PostgreSQL --------------------------------------------------------------
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=airvibe
# POSTGRES_PORT=5432

# --- ChirpStack API (optional — enables Class C auto-switch for FUOTA) -------
# Generate an API key in the ChirpStack web UI after first run.
CHIRPSTACK_API_URL=http://chirpstack:8080
# CHIRPSTACK_API_KEY=
CHIRPSTACK_APPLICATION_ID=1

# --- ThingPark API (reserved for future ThingParkClient.js) ------------------
# TP_CLIENT_ID=
# TP_CLIENT_SECRET=
# TP_SUBSCRIBER_ID=

# --- FUOTA timing overrides (optional) ---------------------------------------
# FUOTA_BLOCK_INTERVAL_MS=10000
# FUOTA_SESSION_TIMEOUT_MS=259200000
```

---

#### `README.md`
Full rewrite. The current README is entirely ChirpStack-focused — references `on_premise` branch, presents the product as single-mode, has no guidance for ThingPark users. After the merge it must serve both audiences. See Section 3.5 for the complete section-by-section specification.

---

### 3.3 Files that require no changes

| File | Reason |
|------|--------|
| `backend/src/adapters/chirpstack.js` | Already correct; passthrough on unrecognised topics |
| `backend/src/services/FUOTAManager.js` | Uses ChirpStackClient; gracefully no-ops when `CHIRPSTACK_API_KEY` absent — covers ThingPark manual-switch scenario |
| `backend/src/services/ChirpStackClient.js` | No-op path already handles ThingPark mode |
| `backend/src/services/WaveformManager.js` | Canonical-format only |
| `backend/src/services/MessageTracker.js` | Canonical-format only |
| All other backend services | No network server dependency |
| All frontend files | Only talks to backend REST/Socket.io |
| `mosquitto/` | Mode-agnostic broker |
| `chirpstack/` config files | Only loaded in `full` profile |

---

### 3.4 Replace `postgres/init-chirpstack.sql` with `chirpstack-db-init` sidecar

**The problem with the current approach:**
`init-chirpstack.sql` runs only when the `postgres_data` volume is first created. If someone switches from ThingPark to ChirpStack mode on an existing installation the script never runs — ChirpStack fails to connect. The comment in the file literally tells users to run a manual `docker exec` command. That's the exact kind of manual step we want to eliminate.

**The fix: `chirpstack-db-init` one-shot sidecar in `docker-compose.yml`**

```yaml
chirpstack-db-init:
  image: postgres:16-alpine
  profiles: [full]
  environment:
    - PGPASSWORD=${POSTGRES_PASSWORD:-postgres}
  command: >-
    sh -c "
      until pg_isready -h postgres -U ${POSTGRES_USER:-postgres}; do
        echo 'chirpstack-db-init: waiting for postgres...'; sleep 2;
      done &&
      psql -h postgres -U ${POSTGRES_USER:-postgres} -tc
        \"SELECT 1 FROM pg_database WHERE datname='chirpstack'\" | grep -q 1 ||
      psql -h postgres -U ${POSTGRES_USER:-postgres}
        -c 'CREATE DATABASE chirpstack;' &&
      psql -h postgres -U ${POSTGRES_USER:-postgres} -d chirpstack
        -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
    "
  depends_on:
    postgres:
      condition: service_healthy
  restart: "no"
```

This runs on every `docker compose up`, is fully idempotent (`grep -q 1 ||` only creates the DB if it doesn't exist, `IF NOT EXISTS` on the extension), and requires no volume state.

**Also:** remove `./postgres/init-chirpstack.sql` from the postgres service's volume mount. The sidecar is the single source of truth for ChirpStack DB setup. The `postgres/init-chirpstack.sql` file can be deleted.

> **Why `condition: service_completed_successfully` on ChirpStack's `depends_on`:** ChirpStack's migration runs on startup and will crash if the `chirpstack` database doesn't exist. Making it wait for the sidecar to exit successfully ensures the DB and pg_trgm extension are ready before ChirpStack begins its migration.

---

### 3.5 README Specification (Section-by-Section)

The README rewrite must produce a single document that serves both ChirpStack and ThingPark users from the first paragraph. Every section below describes what to include, what tone to use, and what the current version gets wrong.

---

#### Title
**Current:** `AirVibe Waveform Manager — On-Premise Edition`
**New:** `AirVibe Waveform Manager`
Remove the edition qualifier — the product is now unified.

---

#### Opening paragraph
One sentence describing what the product does. One sentence stating that it supports two deployment modes. No mode is presented as the default or "real" version.

> *Example direction:* "AirVibe Waveform Manager is a Docker-based platform for monitoring, managing, and firmware-updating AirVibe vibration sensors over LoRaWAN. It runs in two modes: **on-premise** (self-hosted ChirpStack LoRaWAN network server, no cloud dependency) and **cloud** (Actility ThingPark network server, AirVibe management layer only)."

Remove the current `> Looking for the cloud version? See main branch.` callout entirely — there will be one branch.

---

#### Section: Choosing Your Deployment Mode

This is the most important new addition. It must appear **before** any technical quick-start content because a user who picks the wrong mode will waste significant time. It should cover:

**Side-by-side comparison table:**

| | On-Premise (ChirpStack) | Cloud (ThingPark) |
|---|---|---|
| LoRaWAN network server | ChirpStack v4, runs in Docker on your hardware | Actility ThingPark (SaaS, cloud-hosted) |
| Internet required at runtime | No — fully air-gapped capable | Yes — gateways and data always transit Actility's cloud |
| Data sovereignty | All sensor data stays on your hardware | Sensor payload data transits Actility infrastructure |
| Cost | Free and open-source (hardware + hosting costs only) | Actility ThingPark subscription required |
| Gateway setup | Point packet forwarder at your LAN IP (UDP 1700) | Point packet forwarder at Actility's network server |
| Hardware required | Linux host (x86-64 or ARM64, ≥ 2 GB RAM) | No additional server hardware (or minimal for AirVibe app only) |
| Initial setup complexity | Higher — ChirpStack UI, device provisioning, gateway config | Lower — ThingPark handles LoRaWAN provisioning |
| FUOTA Class C auto-switch | Automatic via ChirpStack API (optional API key) | Manual — set Class C in ThingPark portal before each session |
| LoRaWAN stack control | Full — ADR, channels, join server all configurable | Managed by Actility |
| Suitable for | Air-gapped facilities, strict data-residency requirements, greenfield deployments | Existing ThingPark subscribers, minimal on-site hardware |

**Decision guide prose** (2–3 sentences each, not bullet points):

*Choose on-premise if:* your facility has no reliable internet, you have data-residency or compliance requirements that prohibit cloud transit, or you are building a new deployment from scratch and want full control of the LoRaWAN stack.

*Choose ThingPark if:* you are already a ThingPark subscriber with devices provisioned on that network, you want Actility to manage LoRaWAN infrastructure, or your deployment has limited on-site IT capability for server management.

*Not sure?* The on-premise mode is the default — it requires more initial setup but gives you complete independence from any external service.

---

#### Section: Features
Update the FUOTA row to note the ThingPark distinction:

| Feature | Description |
|---|---|
| ... | ... |
| **FUOTA Manager** | Firmware-over-the-air updates with block transmission, verify/retry loop, and missed-block map. Class A↔C auto-switching via ChirpStack API (on-premise) or manual switch via ThingPark portal (cloud). |
| **ChirpStack UI** | *(On-premise only)* Full LoRaWAN network management: gateways, devices, applications, live frame log |

---

#### Section: Architecture
Replace the single architecture diagram with two clearly labelled diagrams — one per mode — under `### On-Premise Architecture` and `### Cloud / ThingPark Architecture`.

**On-premise diagram:** Keep the existing one (already accurate).

**ThingPark diagram** (new, ASCII):
```
AirVibe sensors (LoRa RF)
    │
LoRaWAN Gateways (1..N)
    │  UDP — points at Actility network server endpoints
    ▼
┌──────────────────── Actility ThingPark Cloud ──────────────────────┐
│  Actility LoRaWAN Network Server + Application Server              │
│  Decrypts payload, publishes DevEUI_uplink JSON to customer broker │
└────────────────────────────┬───────────────────────────────────────┘
                             │  MQTTS (customer MQTT endpoint)
                             ▼
┌──── Your AirVibe host ─────────────────────────────────────────────┐
│  postgres                                                          │
│  AirVibe backend (connects to ThingPark MQTT broker)               │
│  AirVibe frontend + Caddy  (port 443)                              │
└────────────────────────────────────────────────────────────────────┘
    ▲
Browser / Tablet
```

**Data flow for ThingPark** — describe separately from ChirpStack flow:
1. Sensor → Gateway → Actility ThingPark (decrypts, decodes)
2. ThingPark publishes `DevEUI_uplink` JSON to your MQTT endpoint
3. AirVibe backend subscribes to your MQTT endpoint via `MQTT_BROKER_URL`
4. ThingPark adapter passthrough (message already in canonical format)
5. WaveformManager + FUOTAManager process identically to on-premise mode

---

#### Section: Requirements
Split into two sub-sections:

**On-premise requirements** (keep current content):
- Docker + Docker Compose v2
- Linux host (x86-64 or ARM64, ≥ 2 GB RAM, ≥ 8 GB storage)
- LoRaWAN gateway with Semtech UDP Packet Forwarder
- AirVibe sensors with DevEUI + AppKey
- No internet required at runtime

**ThingPark requirements** (new):
- Docker + Docker Compose v2
- Any host with Docker support (≥ 512 MB RAM, ≥ 8 GB storage)
- Active Actility ThingPark subscription
- Gateways and devices already provisioned on ThingPark
- ThingPark MQTT bridge URL and credentials
- Public domain name (for HTTPS via Let's Encrypt) — or access directly via host IP with self-signed cert

---

#### Section: Quick Start
Restructure into three clearly delineated sub-sections. Each must be independently scannable — a ThingPark user should be able to follow their section without reading the ChirpStack one.

**Quick Start A — On-premise, full stack (default)**

```bash
git clone <repo-url> && cd AirVibe_Waveform_Manager
cp .env.example .env
# Defaults work as-is for localhost — no edits needed for local testing
docker compose up -d --build
```
Services that start: all 8. Access: `https://localhost` (browser warning until CA trusted — see TLS Setup).
Then follow ChirpStack Initial Setup to register your gateway and devices.

**Quick Start B — On-premise, connect to existing ChirpStack**
For plants that already run ChirpStack. Change 4 values in `.env`:
```bash
COMPOSE_PROFILES=          # empty — don't start bundled ChirpStack
MQTT_BROKER_URL=mqtt://192.168.1.100:1883
CHIRPSTACK_API_URL=http://192.168.1.100:8080
DOMAIN=localhost           # or your AirVibe host's LAN hostname
```
Services that start: 4 (postgres, backend, frontend, caddy).

**Quick Start C — Cloud / ThingPark**
Change 4 values in `.env`:
```bash
NETWORK_SERVER=thingpark
COMPOSE_PROFILES=          # empty — no bundled LoRaWAN infrastructure
DOMAIN=airvibe.yourcompany.com
MQTT_BROKER_URL=mqtts://lora-eu868-devices.thingpark.com:8883   # your ThingPark endpoint
MQTT_USER=your-thingpark-mqtt-username
MQTT_PASS=your-thingpark-mqtt-password
NEXT_PUBLIC_API_URL=https://airvibe.yourcompany.com
```
Services that start: 4 (postgres, backend, frontend, caddy).
TLS: Caddy requests a Let's Encrypt certificate automatically for `DOMAIN` — no `tls internal` required, but the host must be reachable from the internet on port 80/443 for the ACME challenge.

Include a note about ThingPark MQTT endpoint formats and where to find credentials in the ThingPark portal.

---

#### Section: Deployment Profiles (existing section)
Retitle to **Deployment Profiles & Network Architecture**. Keep the existing full/app-only content. Add a third sub-section:

**ThingPark / cloud profile**
Explain that `COMPOSE_PROFILES=` (empty) starts the same 4-service set as the ChirpStack app-only profile, but with `NETWORK_SERVER=thingpark` the adapter is switched to passthrough and the demo simulator emits ThingPark-format messages. Include the same ASCII diagram from the Architecture section.

**Network access table** — add ThingPark row:

| Source | Destination | Protocol | Port | Required by |
|---|---|---|---|---|
| LoRaWAN gateways | Linux box | UDP | 1700 | On-premise full only |
| Browser | Linux box (Caddy) | TCP | 443 | Always |
| AirVibe backend | ThingPark MQTT endpoint | TCP | 8883 | ThingPark mode |
| AirVibe backend | ChirpStack box | TCP | 1883 / 8080 | On-premise app-only |
| Internet (ACME) | Linux box | TCP | 80, 443 | ThingPark mode (Let's Encrypt) |

---

#### Section: ChirpStack Initial Setup
Add a clear `> **On-premise mode only.** ThingPark users skip this section.` callout at the top. No other changes needed.

---

#### Section: ThingPark Initial Setup (new)
Add a new section, symmetric to the ChirpStack one, covering:

1. **Find your MQTT endpoint** — ThingPark portal → Network → MQTT API → copy the broker URL
2. **Create MQTT credentials** — ThingPark portal → Users → your user → MQTT credentials
3. **Verify device provisioning** — confirm DevEUIs and AppKeys are registered in ThingPark before starting AirVibe
4. **Configure `.env`** — fill in `MQTT_BROKER_URL`, `MQTT_USER`, `MQTT_PASS`, `DOMAIN`, `NETWORK_SERVER=thingpark`
5. **FUOTA note** — Class C switching is not automated in the current release. Before starting a FUOTA session: ThingPark portal → Devices → your device → Device Profile → switch to a Class C profile. Restore after the session completes.
6. **Domain and TLS** — for HTTPS, point your domain's DNS A record at the AirVibe host. Caddy handles certificate issuance automatically via Let's Encrypt on first request.

---

#### Section: Enabling FUOTA Class C Auto-Switch
Add a mode-conditional structure:

**On-premise (ChirpStack):** Keep existing instructions — generate API key, add to `.env`, restart backend.

**Cloud (ThingPark):** Automatic switching is not available in the current release. Manual steps:
1. Before starting a FUOTA session: ThingPark portal → device → Device Profile → assign a Class C profile
2. Start the FUOTA session in AirVibe — the "Class C auto-switch not configured" warning in the UI is expected
3. After the session completes or is aborted: restore the original Class A device profile in ThingPark

Note that the FUOTA state machine, block transmission, verify/retry loop, and missed-blocks map all function identically in both modes.

---

#### Section: TLS Setup
Restructure into two sub-sections:

**On-premise — `tls internal` (LAN self-signed)**
Keep existing content (export CA cert, import into OS trust store, per-OS table).

**Cloud — Automatic ACME / Let's Encrypt**
Explain: when `DOMAIN` is set to a public domain and `NETWORK_SERVER=thingpark`, Caddy's entrypoint detects it is not localhost and omits the `tls internal` directive. Caddy automatically requests a certificate from Let's Encrypt. Requirements:
- Port 80 and 443 must be reachable from the internet (for the ACME HTTP-01 challenge)
- `DOMAIN` DNS A record must point at the AirVibe host
- No browser warning — certificate is publicly trusted

---

#### Section: Switching Modes (new)
Add a new section covering how to safely switch between modes on an existing deployment. This is critical to document because several things have rebuild or data implications:

**Switching from on-premise to ThingPark (or vice versa):**

```bash
# 1. Stop the stack
docker compose down

# 2. Edit .env — change NETWORK_SERVER, COMPOSE_PROFILES, DOMAIN,
#    MQTT_BROKER_URL, NEXT_PUBLIC_API_URL

# 3. Rebuild and restart (NEXT_PUBLIC_API_URL is baked into the frontend
#    bundle — a rebuild is always required when it changes)
docker compose up -d --build
```

**Data note:** Your PostgreSQL `airvibe` database (waveform history, device registry, FUOTA sessions, audit log) is preserved across mode switches — it lives on the `postgres_data` Docker volume. The `chirpstack` database (device provisioning, gateway config) is only relevant in on-premise mode and is not touched by ThingPark operation.

**Important:** `NEXT_PUBLIC_API_URL` is compiled into the Next.js JavaScript bundle at `docker compose build` time. Simply restarting the frontend container after changing this variable has no effect. Always run `docker compose up -d --build` after changing any `NEXT_PUBLIC_*` variable.

---

#### Section: Environment Variables
Add `NETWORK_SERVER` as the first row. Fix the `NEXT_PUBLIC_API_URL` default from `http://localhost:4000` to `https://localhost`. Add a "Mode" column:

| Variable | Default | Mode | Description |
|---|---|---|---|
| `NETWORK_SERVER` | `chirpstack` | Both | `chirpstack` or `thingpark` — selects MQTT adapter and Caddyfile TLS mode |
| `COMPOSE_PROFILES` | _(none)_ | Both | Set `full` to start bundled ChirpStack+Mosquitto+Redis |
| `DOMAIN` | `localhost` | Both | Hostname for Caddy TLS and CORS |
| `NEXT_PUBLIC_API_URL` | `https://localhost` | Both | Browser-accessible backend URL — baked into frontend at build time |
| `MQTT_BROKER_URL` | `mqtt://mqtt-broker:1883` | Both | Override in app-only or ThingPark mode |
| `MQTT_USER` | _(none)_ | Both | Optional MQTT username |
| `MQTT_PASS` | _(none)_ | Both | Optional MQTT password |
| `POSTGRES_USER` | `postgres` | Both | |
| `POSTGRES_PASSWORD` | `postgres` | Both | Change in production |
| `POSTGRES_DB` | `airvibe` | Both | AirVibe application database |
| `CHIRPSTACK_API_URL` | `http://chirpstack:8080` | On-premise | Override in app-only mode |
| `CHIRPSTACK_API_KEY` | _(none)_ | On-premise | Enables Class C auto-switch for FUOTA |
| `CHIRPSTACK_APPLICATION_ID` | `1` | On-premise | App ID from ChirpStack UI |

---

#### Section: Project Structure
Update for new/changed files:

```
├── caddy/
│   └── entrypoint.sh               # Generates Caddyfile at runtime from NETWORK_SERVER + DOMAIN
├── docker-compose.yml              # 8-service stack (profiles: full / app-only)
├── .env.example                    # Unified template — covers both modes
...
├── backend/
│   └── src/
│       ├── adapters/
│       │   ├── chirpstack.js       # ChirpStack ↔ internal format adapter
│       │   └── thingpark.js        # ThingPark passthrough adapter (identity)
│       └── services/
│           ├── DemoSimulator.js    # Dual-mode: emits ChirpStack or ThingPark format
│           ...
```

Remove `├── Caddyfile` (no longer a static tracked file — generated at runtime).
Add `chirpstack-db-init` to the Docker Services Reference table.

---

#### Section: Troubleshooting
Add a **ThingPark-specific** subsection:

**Backend not receiving messages in ThingPark mode**
```bash
docker logs mqtt-manager-backend | grep -E "MQTT|adapter"
# Confirm: "MQTT adapter: thingpark" — if not, check NETWORK_SERVER in .env
# Confirm: "Connected to MQTT Broker" — if not, check MQTT_BROKER_URL/credentials
```

**Downlinks not reaching devices (ThingPark)**
```bash
docker logs mqtt-manager-backend | grep downlink
# Verify messages are published to mqtt/things/{devEUI}/downlink (not ChirpStack topic format)
# If ChirpStack topic format appears, NETWORK_SERVER is set to chirpstack — fix .env and rebuild
```

**FUOTA "Class C not configured" warning (ThingPark)**
Expected. Switch the device profile manually in ThingPark portal before starting a FUOTA session. This is documented in the ThingPark FUOTA section.

**Let's Encrypt certificate not issued (ThingPark)**
- Confirm `DOMAIN` DNS A record points at this host
- Confirm ports 80 and 443 are reachable from the internet
- Check Caddy logs: `docker logs mqtt-manager-caddy`

---

#### Section: Docker Services Reference
Add `chirpstack-db-init` row:

| Container | Image | Profile | Purpose |
|---|---|---|---|
| `chirpstack-db-init` | `postgres:16-alpine` | full | One-shot: ensures ChirpStack DB and pg_trgm extension exist. Exits after completion. |

---

#### Tone and style notes for the rewrite
- Do not frame either mode as "advanced" or "for experts" — both are first-class
- Do not imply ThingPark is simpler because it requires less setup — acknowledge it requires a subscription and has data-residency implications
- Keep the existing LoRaWAN primer paragraph ("LoRaWAN in one paragraph") — it is genuinely useful for new users regardless of mode
- The ChirpStack Initial Setup section is already excellent — keep its structure and depth, just add the "on-premise only" callout at the top
- Match the new ThingPark Initial Setup section's depth to the ChirpStack one — don't give ThingPark users a weaker experience

---

## 4. Decisions Requiring Genuine Manual Input (Cannot Be Automated)

These are the only things a ThingPark user must provide — everything else is derived or defaulted:

| Setting | Why it can't be automated |
|---------|--------------------------|
| `DOMAIN` | Your organisation's DNS name — only you know it |
| `MQTT_BROKER_URL` | Your ThingPark account's MQTT endpoint — only you know it |
| `NEXT_PUBLIC_API_URL` | Must match `DOMAIN`; baked into Next.js bundle at build time |
| `MQTT_USER` / `MQTT_PASS` | ThingPark MQTT credentials |
| ChirpStack API key | Generated in ChirpStack UI after first run (one-time step, ChirpStack mode only) |

Everything else — TLS mode, Caddyfile content, DB creation, service graph, adapter selection — is automated from these inputs.

---

## 5. Phased Execution Plan

Each phase is independently committable and testable. Execute in order.

---

### Phase 0 — Pre-flight: commit untracked files + housekeeping
**Files:** `backend/test/adapter.test.js`, `backend/test/waveform.test.js`, `scripts/smoke-test.sh`, `ON_PREMISE_SWITCHOVER.md`
**Risk:** None — no logic changes.

These files exist on disk but are not tracked by git. They must be committed before any feature work begins, otherwise the eventual fast-forward to `main` will carry unrelated uncommitted state into the wrong context.

**Steps:**
1. Commit `backend/test/` and `scripts/smoke-test.sh` as-is (existing tests pass, smoke test works in its current form).
   - `scripts/smoke-test.sh` currently tests `COMPOSE_PROFILES=full` (8 services) and `COMPOSE_PROFILES=` (4 services) for the ChirpStack profile. There is no ThingPark-mode test block yet. **Add a ThingPark mode smoke test block** in Phase 4 alongside the docker-compose changes — it can be limited to service-startup verification: `NETWORK_SERVER=thingpark COMPOSE_PROFILES= docker compose up -d` → exactly 4 services, no `mqtt-broker` container, Caddy Caddyfile contains no `tls internal` line.
2. **Delete `ON_PREMISE_SWITCHOVER.md`** — it is a migration planning artifact for the one-way ThingPark → ChirpStack transition. Its operational content (architecture, setup steps, env vars) is fully superseded by the updated `README.md` and `MERGE_PLAN.md`. Keeping it causes confusion: after the merge there is no "ThingPark branch to migrate from." Delete it with `git rm`.

---

### Phase 1 — `adapters/thingpark.js` + test
**Files:** `backend/src/adapters/thingpark.js` (new), `backend/test/adapter.test.js` (extend)
**Risk:** None — new file, not imported by anything yet.

The existing `adapter.test.js` tests only the ChirpStack adapter. After adding the ThingPark passthrough, add a small test block that verifies both `normalizeIncoming` and `normalizeOutgoing` return their inputs byte-for-byte unchanged — the entire contract of the passthrough adapter.

---

### Phase 2 — `mqttClient.js` adapter selection
**Files:** `backend/src/mqttClient.js`
**Change:** 3-line require swap + startup log line.
**Test:** `NETWORK_SERVER` unset → ChirpStack adapter loads, existing behaviour unchanged. `NETWORK_SERVER=thingpark` → ThingPark adapter loads (confirm via log).

---

### Phase 3 — `DemoSimulator.js` dual-mode
**Files:** `backend/src/services/DemoSimulator.js`
**Change:** Add `buildThingParkUplink()`, make `_publish()` mode-aware.
**Test:** Demo in ChirpStack mode (default) → unchanged. Demo in ThingPark mode → waveforms arrive at WaveformManager in canonical format without adapter translation errors.

---

### Phase 4 — `docker-compose.yml` updates
**Files:** `docker-compose.yml`, `caddy/entrypoint.sh` (new), `postgres/init-chirpstack.sql` (delete), `Caddyfile` (delete from git), `.gitignore` (add `Caddyfile` entry), `scripts/smoke-test.sh` (extend with ThingPark test block)
**Changes:** `NETWORK_SERVER` env var on backend; Caddy entrypoint script replacing static Caddyfile mount; `chirpstack-db-init` sidecar; ChirpStack `depends_on` update; `NEXT_PUBLIC_API_URL` default fix; explicit removal of `Caddyfile` from version control.

**Explicit git operations in this phase:**
```bash
git rm Caddyfile                   # remove the static Caddyfile from git tracking
git rm postgres/init-chirpstack.sql  # replaced by chirpstack-db-init sidecar
# Add 'Caddyfile' to .gitignore before committing
```
The `Caddyfile` generated at runtime by `caddy/entrypoint.sh` must never be committed. Adding it to `.gitignore` prevents accidental re-addition.

**Risk:** Medium. Verify:
- `docker compose config` parses cleanly
- `COMPOSE_PROFILES=full docker compose up -d` → all 8 services start, ChirpStack UI accessible
- `docker compose up -d` (no profile) → only 4 services start
- Caddy generates the right Caddyfile in each mode (`docker exec mqtt-manager-caddy cat /etc/caddy/Caddyfile`)
- `chirpstack-db-init` runs and exits cleanly (`docker compose logs chirpstack-db-init`)
- ChirpStack starts successfully after `chirpstack-db-init` completes

**Gotcha — `condition: service_completed_successfully` requires Docker Compose v2.1+.** This has been available since December 2021 and ships with Docker Desktop 4.x and Docker Engine 20.10+. If any deployment target runs older Docker, fall back to a `restart: on-failure` + healthcheck approach instead.

---

### Phase 5 — `.env.example` unification
**Files:** `.env.example`
**Risk:** None — example file only.
**Test:** `cp .env.example .env && docker compose up -d --build` → full ChirpStack stack starts, HTTPS at `https://localhost` works, demo mode works.

---

### Phase 6 — `README.md` + `CLAUDE.md` rewrite
**Files:** `README.md`, `CLAUDE.md`
**Risk:** None — documentation only.

#### README.md
**Scope:** Full rewrite per the section-by-section spec in Section 3.5. The current README is ChirpStack-only and references the `on_premise` branch throughout. Every user-facing decision point must now cover both modes clearly.
**Key things to get right:**
- The mode-comparison table must be honest about ThingPark's subscription cost and data-transit implications
- The "Choosing Your Mode" section must be the first substantive section — this is the most important thing a new user needs
- ThingPark quick-start must be as scannable as the ChirpStack one — same structure, different values
- TLS section must explain both paths (tls internal vs ACME) without assuming one is "normal"
- FUOTA section must explicitly state that ThingPark requires manual Class C switching (no auto-switch in current release)
- Switching-modes section must cover the rebuild requirement for `NEXT_PUBLIC_API_URL`

#### CLAUDE.md
The current `CLAUDE.md` describes a ChirpStack-only architecture. After the merge it will be incorrect for anyone (including future AI sessions) working on ThingPark features. Update the following sections:

**Project Overview paragraph:** Replace "no cloud network server required" framing with the unified two-mode description — same opening sentence style as the new README.

**Architecture → Services table:** Mark ChirpStack, Redis, Mosquitto, and chirpstack-gateway-bridge as `profiles: [full]`. Add `chirpstack-db-init` row.

**Architecture → Real-time data flow:** Add a parallel ThingPark data flow description below the ChirpStack one (or restructure as a two-column table).

**Backend modules section:** Update `mqttClient.js` description to mention dynamic adapter selection via `NETWORK_SERVER`. Add `adapters/thingpark.js` entry. Update `DemoSimulator.js` description to mention dual-mode uplink building.

**Key Conventions → Environment variables:** Add `NETWORK_SERVER` as the first entry.

**The `caddy/entrypoint.sh` pattern:** Replace the implicit Caddyfile reference with a description of the generated-at-runtime approach.

The CLAUDE.md update should be a single commit alongside or immediately after the README commit — both are documentation and can be reviewed together.

---

### Phase 7 — Fast-forward `main`
```bash
git checkout main
git merge --ff-only on_premise
git push origin main
```
Linear history, no conflicts possible. Do this after all phases are committed and tested on `on_premise`.

---

## 6. Gotchas & Things to Watch Out For

### 6.1 Caddy TLS volume and mode switching
When switching from `tls internal` (ChirpStack) to ACME (ThingPark) **on the same `DOMAIN` value** — which should never happen in practice since ChirpStack uses `localhost` and ThingPark uses a real domain — Caddy may attempt to reuse a cached cert. In practice this scenario doesn't arise because the `DOMAIN` value changes between modes. No special handling needed.

### 6.2 `NEXT_PUBLIC_API_URL` is baked into the Next.js bundle
Changing `NEXT_PUBLIC_API_URL` in `.env` requires a full `docker compose build` to take effect. A `docker compose restart frontend` is not sufficient. Make this prominent in the README and switching guide.

### 6.3 `COMPOSE_PROFILES` must be set before `docker compose up`, not after
If an operator runs `docker compose up -d` without `COMPOSE_PROFILES=full` and then sets it later, the ChirpStack services will not start until `docker compose up -d` is run again. Order of operations: set `.env` first, then bring the stack up.

### 6.4 `chirpstack-db-init` sidecar writes output to compose logs
The sidecar's output (including psql "already exists" messages from `CREATE EXTENSION IF NOT EXISTS`) will appear in `docker compose logs`. These are informational and not errors — document this so operators aren't alarmed.

### 6.5 `mqtt-broker` is in the `full` profile — ThingPark mode has no bundled broker
In app-only/ThingPark mode, Mosquitto does not start. The backend's default `MQTT_BROKER_URL=mqtt://mqtt-broker:1883` would fail. The `.env.example` correctly documents that ThingPark users must override `MQTT_BROKER_URL`. The backend has reconnect logic (`reconnectPeriod: 1000`) so a transient connection failure is survivable, but an incorrect URL will loop indefinitely. Make this a prominent ThingPark setup step.

### 6.6 GitHub Actions CI
Current: `docker compose build`. Must be updated to `docker compose --profile full build` (or set `COMPOSE_PROFILES=full` in the CI env) to include all services. Consider adding a second CI job without the profile to validate the 4-service ThingPark subset also builds cleanly.

### 6.7 `Caddyfile` removal from git
The static `Caddyfile` tracked in git should be **deleted** once the `caddy/entrypoint.sh` approach is in place. Leaving it tracked is confusing since it's never used. Add `Caddyfile` to `.gitignore` as a safety net (in case something re-generates it locally).

---

## 7. Testing Checklist

### ChirpStack / full profile
- [ ] `cp .env.example .env && docker compose up -d --build` — zero edits, all 8 services start
- [ ] `docker compose logs chirpstack-db-init` — shows successful DB/extension creation, exits 0
- [ ] ChirpStack UI at `http://localhost:8080` — accessible
- [ ] `https://localhost` — Caddy self-signed cert served (browser warning expected until root CA imported)
- [ ] `docker exec mqtt-manager-caddy cat /etc/caddy/Caddyfile` — contains `tls internal`
- [ ] MQTT adapter log shows `MQTT adapter: chirpstack`
- [ ] Demo mode → waveforms appear in Waveform Manager tab
- [ ] FUOTA session → blocks sent, 0x11 uplink processed, missed blocks map renders
- [ ] Backend restart → active sessions restored from DB

### ThingPark / app-only (requires an actual ThingPark account or mock broker)
- [ ] `.env` with `NETWORK_SERVER=thingpark`, `COMPOSE_PROFILES=` (empty), correct `MQTT_BROKER_URL` → exactly 4 services start
- [ ] `docker exec mqtt-manager-caddy cat /etc/caddy/Caddyfile` — no `tls internal` line
- [ ] MQTT adapter log shows `MQTT adapter: thingpark`
- [ ] Uplink from ThingPark format arrives at WaveformManager (canonical passthrough)
- [ ] Downlink from DownlinkBuilder → published in `DevEUI_downlink` format (not ChirpStack format)
- [ ] Demo mode in ThingPark mode → waveforms appear (buildThingParkUplink path)
- [ ] FUOTA Class C banner shows "not configured — switch manually" (no API key)

### Regression (both modes)
- [ ] Certificate management generates and downloads certs
- [ ] MQTT Monitor shows live messages
- [ ] Session history persists across backend restart
- [ ] `cd frontend && npm run lint` — clean
- [ ] `cd frontend && npm run build` — clean
- [ ] `docker compose --profile full build` — CI passes

---

## 8. Out of Scope (Future Work)

- **`ThingParkClient.js`**: OAuth2-based automatic Class C switching for ThingPark FUOTA. Interface is identical to `ChirpStackClient.js`; wiring it in is a 2-line change to `FUOTAManager.js`. Left as follow-up because it requires ThingPark DX Core API credentials and testing.
- **Runtime `NEXT_PUBLIC_API_URL`**: Migrate from Next.js build-arg baking to `publicRuntimeConfig` so the API URL can be changed without a rebuild. Would simplify ThingPark mode onboarding significantly.
- **Automated E2E testing**: CI job that spins up both modes with a mock LoRaWAN device and validates the full uplink → waveform pipeline.
