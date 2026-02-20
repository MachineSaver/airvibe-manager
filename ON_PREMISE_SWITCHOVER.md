# On-Premise Switchover Plan
## AirVibe Waveform Manager — Actility → ChirpStack Edge Deployment

**Branch:** `on_premise`
**Date:** 2026-02-19
**Status:** Requirements / Pre-implementation

---

## 1. Purpose

This document defines the requirements and sequenced implementation plan for converting the AirVibe Waveform Manager from its current cloud-dependent architecture (Actility ThingPark as LoRaWAN Network/Application Server) to a fully self-contained on-premise edge deployment running entirely inside Docker. The resulting stack must:

- Operate on an isolated industrial LAN or VPN with no required internet access
- Preserve all existing functionality: MQTT Monitor, Waveform Manager, FUOTA Manager
- Deploy via a single `docker compose up` on any Linux host
- Require zero Actility/ThingPark account or license
- Support secure remote access through optional VPN overlay (no exposed ports)

---

## 2. What Actility Currently Provides

Understanding the precise services consumed from Actility is essential before removing them. There are three distinct roles:

| Role | Actility Component | Description |
|---|---|---|
| **LoRaWAN Network Server (LNS)** | ThingPark Wireless | Gateway connectivity, radio channel plans, ADR, MAC commands, duty cycle, deduplication |
| **LoRaWAN Application Server (AS)** | ThingPark DX Bridge | Decrypts application payload (AppSKey), formats into JSON, routes to our Mosquitto broker |
| **Device Management API** | ThingPark DX Core API | Class A ↔ Class C profile switching used by FUOTA Manager before/after firmware updates |

Everything else in the current stack — Mosquitto, PostgreSQL, the backend, the frontend — is already self-contained and makes no external calls at runtime.

---

## 3. Selected Replacement: ChirpStack v4

**ChirpStack** (chirpstack.io) is an open-source LoRaWAN Network Server and Application Server. It is the standard choice for on-premise LoRaWAN deployments and directly replaces all three Actility roles listed above.

**Why ChirpStack over alternatives:**

| Option | Decision |
|---|---|
| **ChirpStack v4** | ✅ Selected. Open-source, Docker-native, PostgreSQL + Redis, MQTT output, REST API for device management, supports all major gateways. |
| The Things Stack (TTS) | ❌ Skip. Open-source but built for cloud scale; significantly more complex to self-host than ChirpStack. |
| Node-RED | ❌ Skip as a data path component. Useful for visual prototyping but adds maintenance debt when the same transformation is three lines of code in the backend adapter. |
| Loriot | ❌ Skip. Commercial, no self-hosted option. |
| RAK WisGate built-in LNS | ❌ Vendor-locked. Only relevant if the entire hardware fleet is RAK. |

ChirpStack v4 collapses the Network Server and Application Server into a single container, uses PostgreSQL (which we already run), and publishes decrypted uplinks to our existing Mosquitto broker via MQTT. The only new infrastructure dependency is Redis.

---

## 4. Current Architecture vs. Target Architecture

### 4.1 Current (Actility-connected)

```
LoRaWAN Gateway
  → [internet] → Actility ThingPark (LNS + AS)
                      → [MQTT over internet] → Mosquitto (our broker)
                      → [ThingPark DX API] → Backend (Class C switching)

Docker Host (VPS)
  ├── mqtt-broker (Mosquitto)
  ├── postgres
  ├── backend (Express + Socket.io)
  ├── frontend (Next.js)
  └── caddy (Let's Encrypt auto-TLS)

Browser → public domain → Caddy → frontend/backend
```

### 4.2 Target (on-premise, no internet required)

```
LoRaWAN Gateway
  → [LAN/UDP :1700] → chirpstack-gateway-bridge (UDP → MQTT)
                            → mqtt-broker (Mosquitto, internal)
                                  → chirpstack (LNS + AS)
                                  → backend (our app, via message adapter)

Docker Host (any Linux box on LAN)
  ├── chirpstack-gateway-bridge   (new)
  ├── chirpstack                  (new)
  ├── redis                       (new, required by ChirpStack)
  ├── mqtt-broker (Mosquitto)     (unchanged)
  ├── postgres                    (unchanged, shared with ChirpStack)
  ├── backend                     (modified: adapter layer, ChirpStack client)
  ├── frontend                    (minor rename only)
  └── caddy                       (modified: tls internal, no Let's Encrypt)

Browser → LAN IP or .local hostname → Caddy → frontend/backend
```

---

## 5. The One Hard Coupling Point

A full code audit of the current codebase reveals that Actility coupling is **almost entirely contained in the message envelope format**. All MQTT messages are expected to arrive as:

```json
{
  "DevEUI_uplink": {
    "DevEUI": "0000000000000001",
    "FPort": 8,
    "FCntUp": 42,
    "payload_hex": "0312...",
    "LrrRSSI": -95.0,
    "LrrSNR": 7.5
  }
}
```

And downlinks are emitted as:

```json
{
  "DevEUI_downlink": {
    "DevEUI": "0000000000000001",
    "FPort": 20,
    "payload_hex": "2000"
  }
}
```

This format is Actility's proprietary JSON schema. ChirpStack uses a different schema and base64 encoding instead of hex. Every other piece of the application (waveform processing, FUOTA state machine, database schema, PKI, frontend) is already network-server-agnostic.

**ChirpStack uplink format** (MQTT topic: `application/{appId}/device/{devEUI}/event/up`):
```json
{
  "deviceInfo": { "devEui": "0000000000000001", "deviceName": "..." },
  "fPort": 8,
  "fCnt": 42,
  "data": "AxI=",
  "rxInfo": [{ "rssi": -95, "snr": 7.5 }]
}
```

**ChirpStack downlink format** (MQTT topic: `application/{appId}/device/{devEUI}/command/down`):
```json
{
  "devEui": "0000000000000001",
  "confirmed": false,
  "fPort": 20,
  "data": "IAA="
}
```

Key format differences to normalize:
1. `data` is base64-encoded, not `payload_hex` hex string
2. Topic pattern is different — `application/.../device/.../event/up` vs `mqtt/things/.../uplink`
3. `DevEUI` field location differs (`deviceInfo.devEui` vs `DevEUI_uplink.DevEUI`)
4. RSSI/SNR are inside `rxInfo[0]` array vs top-level fields
5. Class C switching uses ChirpStack REST API instead of ThingPark DX Core OAuth2 API

The fix is a **thin normalization adapter** in the backend that translates incoming ChirpStack messages into the internal canonical format before they reach WaveformManager, FUOTAManager, or MessageTracker. All downstream consumers remain unchanged.

---

## 6. File-Level Change Inventory

### 6.1 Files to Delete

| File | Reason |
|---|---|
| `backend/src/services/ThingParkClient.js` | Replaced by ChirpStackClient |

### 6.2 Files to Create (New)

| File | Purpose |
|---|---|
| `backend/src/adapters/chirpstack.js` | Normalizes ChirpStack uplink/downlink JSON to internal canonical format. Translates base64 ↔ hex, remaps field names, extracts DevEUI from topic. |
| `backend/src/services/ChirpStackClient.js` | Replaces ThingParkClient. Calls ChirpStack REST API (`/api/devices/{devEUI}`) to switch device class before/after FUOTA. Uses API key auth (not OAuth2). |
| `chirpstack/chirpstack.toml` | ChirpStack server configuration (PostgreSQL DSN, MQTT broker, API bind address, region config) |
| `chirpstack/region_eu868.toml` | EU868 region config (or US915, AU915, etc. — one file per supported region) |
| `chirpstack/region_us915.toml` | US915 region config |

### 6.3 Files to Modify

| File | Change Required |
|---|---|
| `docker-compose.yml` | Add `chirpstack-gateway-bridge`, `chirpstack`, `redis` services. Modify `caddy` to use `tls internal`. Pass ChirpStack env vars to backend. |
| `Caddyfile` | Replace auto-TLS (`{$DOMAIN}`) with `tls internal` directive for LAN use. Keep routing rules unchanged. |
| `backend/src/mqttClient.js` | Subscribe to ChirpStack topic pattern (`application/+/device/+/event/up`) in addition to or instead of current pattern. Run incoming messages through `chirpstack.js` adapter before dispatch. Update publish logic to emit ChirpStack downlink format to correct topic. |
| `backend/src/services/FUOTAManager.js` | Swap `thingParkClient` import for `chirpStackClient`. Adapt the two Class C switch call sites and the two restore call sites. FUOTA protocol logic (block sending, ACK handling, state machine) is unchanged. |
| `backend/src/index.js` | Remove `thingParkClient` import and `/api/fuota/thingpark-status` endpoint. Add `/api/fuota/network-server-status` endpoint backed by ChirpStackClient. Pass ChirpStack API base URL and key from environment. |
| `frontend/src/components/FUOTAManager.tsx` | Rename `thingParkConfigured` state and the `/api/fuota/thingpark-status` fetch call to network-server equivalents. UI label changes only — no logic changes. |
| `.env.example` | Remove ThingPark vars. Add ChirpStack vars: `CHIRPSTACK_API_URL`, `CHIRPSTACK_API_KEY`, `CHIRPSTACK_APPLICATION_ID`. |
| `CLAUDE.md` | Update architecture description to reflect ChirpStack in the service list and data flow. |

### 6.4 Files That Do Not Change

| File | Why unchanged |
|---|---|
| `backend/src/services/WaveformManager.js` | Consumes internal canonical format — adapter handles translation upstream |
| `backend/src/services/FUOTAManager.js` (protocol logic) | AirVibe FUOTA protocol (block numbering, ACK parsing, state machine, timeouts) is device-specific, not network-server-specific |
| `backend/src/codec/AirVibe_TS013_Codec.js` | Pure device protocol codec, network-server-agnostic |
| `backend/src/services/MessageTracker.js` | Consumes internal canonical format |
| `backend/src/services/AuditLogger.js` | No Actility references |
| `backend/src/db.js` | PostgreSQL connection logic unchanged |
| `backend/src/db/schema.sql` | Schema has no Actility-specific columns |
| `backend/src/pki.js` | X.509 cert generation unchanged; becomes more useful on-premise for gateway mTLS |
| `frontend/src/app/page.tsx` | No Actility references |
| `frontend/src/app/SocketContext.tsx` | No Actility references |
| `frontend/src/components/MQTTMessageCard.tsx` | No Actility references |
| `frontend/src/components/DownlinkBuilder.tsx` | Downlink format translation moves to backend adapter; frontend emits neutral payload |
| `mosquitto/mosquitto.conf` | Broker config unchanged; ChirpStack publishes to same broker |
| `mosquitto/watcher.sh` | Cert watcher unchanged |

---

## 7. New Docker Services

### 7.1 chirpstack-gateway-bridge

Translates the Semtech UDP Packet Forwarder protocol (used by virtually all commercial LoRaWAN gateways out of the box) into MQTT messages on the internal broker. No changes to gateway hardware configuration beyond pointing the packet forwarder at the Docker host IP.

```yaml
chirpstack-gateway-bridge:
  image: chirpstack/chirpstack-gateway-bridge:4
  ports:
    - "1700:1700/udp"   # UDP packet forwarder from gateways
  environment:
    - INTEGRATION__MQTT__EVENT_TOPIC_TEMPLATE=eu868/gateway/{{ .GatewayID }}/event/{{ .EventType }}
    - INTEGRATION__MQTT__COMMAND_TOPIC_TEMPLATE=eu868/gateway/{{ .GatewayID }}/command/#
    - INTEGRATION__MQTT__SERVER=tcp://mqtt-broker:1883
  depends_on:
    - mqtt-broker
  restart: unless-stopped
```

### 7.2 chirpstack

The unified Network Server + Application Server. Reads from Mosquitto (gateway events), manages MAC layer, decrypts application payloads, and publishes decoded uplinks back to Mosquitto for our backend to consume.

```yaml
chirpstack:
  image: chirpstack/chirpstack:4
  volumes:
    - ./chirpstack:/etc/chirpstack
  environment:
    - POSTGRESQL__DSN=postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres/chirpstack?sslmode=disable
    - REDIS__SERVERS=redis:6379
    - NETWORK__NET_IDS=000000
    - NETWORK__ENABLED_REGIONS=eu868
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_started
    mqtt-broker:
      condition: service_started
  ports:
    - "8080:8080"   # ChirpStack web UI + REST API (consider restricting to LAN)
  restart: unless-stopped
```

ChirpStack will need its own database within PostgreSQL (`chirpstack`). Its first-run migration creates the schema automatically.

### 7.3 redis

Required by ChirpStack for device session state and downlink scheduling queues. No persistence required — if Redis restarts, ChirpStack re-registers devices on next uplink.

```yaml
redis:
  image: redis:7-alpine
  volumes:
    - redis_data:/data
  restart: unless-stopped
```

---

## 8. Environment Variable Changes

### 8.1 Variables to Remove

```bash
THINGPARK_BASE_URL
THINGPARK_CLIENT_ID
THINGPARK_CLIENT_SECRET
THINGPARK_CLASS_C_PROFILE
```

### 8.2 Variables to Add

```bash
# ChirpStack API (replaces ThingPark DX Core API for device management)
CHIRPSTACK_API_URL=http://chirpstack:8080
CHIRPSTACK_API_KEY=                        # Generate in ChirpStack web UI after first run
CHIRPSTACK_APPLICATION_ID=                 # Numeric application ID from ChirpStack UI

# Region selection (used to construct correct MQTT topic subscription patterns)
CHIRPSTACK_REGION=eu868                    # or us915, as915, etc.

# Remote access (optional, for VPN/tunnel scenarios)
# DOMAIN can remain localhost for pure LAN use; Caddy will issue a self-signed cert
DOMAIN=localhost
```

### 8.3 Variables That Stay the Same

```bash
DOMAIN
NEXT_PUBLIC_API_URL
MQTT_BROKER_URL
MQTT_USER
MQTT_PASS
POSTGRES_USER
POSTGRES_PASSWORD
POSTGRES_DB
POSTGRES_PORT
```

---

## 9. Caddy TLS Change

The current Caddyfile relies on Let's Encrypt for automatic HTTPS, which requires a public domain and outbound internet access.

**Current:**
```
{$DOMAIN} {
    reverse_proxy /api/* backend:4000
    reverse_proxy /socket.io/* backend:4000
    reverse_proxy /* frontend:3000
}
```

**Target (LAN-compatible):**
```
{$DOMAIN} {
    tls internal
    reverse_proxy /api/* backend:4000
    reverse_proxy /socket.io/* backend:4000
    reverse_proxy /* frontend:3000
}
```

`tls internal` makes Caddy act as its own CA and issue a self-signed certificate. Browsers will show a trust warning on first visit, which can be resolved by importing Caddy's CA cert into the OS trust store — a one-time step. For customers who prefer plain HTTP on a trusted LAN, `http://` can be used directly without Caddy.

If the deployment is on a private domain resolvable within a VPN (e.g., `airvibe.company.internal`), Let's Encrypt with DNS-01 challenge is also an option, but `tls internal` is the lowest-friction path for edge deployments.

---

## 10. Remote Access Options

For customers who need to access the UI from outside the local network without exposing ports to the internet:

| Option | Complexity | Recommendation |
|---|---|---|
| **Tailscale** | Very low — one install command on the host | ✅ Recommended for most customers. Zero port forwarding, zero public exposure. Access via Tailscale-assigned IP or MagicDNS name. |
| **WireGuard** (`linuxserver/wireguard` container) | Medium — client key distribution required | Good for IT-managed environments that want full control. Can run in the stack as an additional service. |
| **Cloudflare Tunnel** (`cloudflared`) | Low — but requires Cloudflare account | Routes traffic through Cloudflare's network. Free tier available. Acceptable if customer is comfortable with Cloudflare as a trusted intermediary. |
| **OpenVPN** | High | Skip unless customer already has OpenVPN infrastructure. |

None of these options change the application stack. The app remains bound to the LAN; the VPN overlay provides the access path.

---

## 11. Gateway Hardware Compatibility

ChirpStack Gateway Bridge supports all major commercial gateways without firmware changes:

| Protocol | Support | Notes |
|---|---|---|
| Semtech UDP Packet Forwarder | ✅ Native | Default on RAK, Dragino, Kerlink, Tektelic, MultiTech, etc. Point packet forwarder at Docker host IP port 1700. |
| Basics Station (LNS protocol) | ✅ Native | More secure (TLS + token auth). Requires gateway firmware support. |
| Basics Station (CUPS protocol) | ✅ Native | Remote config provisioning for Basics Station gateways. |

No gateway firmware updates are required to switch from Actility to this stack. The only gateway-side change is updating the packet forwarder's server address from Actility's cloud endpoint to the Docker host's LAN IP.

---

## 12. ChirpStack Class C Switching (FUOTA Replacement for ThingPark)

The current `ThingParkClient.js` uses OAuth2 client credentials to call the ThingPark DX Core REST API and switch a device's profile between Class A and Class C.

ChirpStack exposes a REST API and gRPC API for the same operation. The replacement `ChirpStackClient.js` will:

1. Authenticate with a static API key (generated once in ChirpStack UI, stored in env) — no OAuth2 token refresh cycle needed
2. Call `PUT /api/devices/{devEUI}` with `device.classEnabled: "CLASS_C"` to switch to Class C before FUOTA
3. Call the same endpoint with `device.classEnabled: "CLASS_A"` to restore after FUOTA completes, fails, or is aborted

The FUOTA Manager call sites in `FUOTAManager.js` (lines 236–245, 492–495, 515–517, 538–540) require only the import swap and method rename. The surrounding logic — session startup, state persistence, timeout handling, block retransmission — is unchanged.

---

## 13. Implementation Sequence

Phases are sequenced to allow incremental validation. Each phase is a discrete commit or PR.

### Phase 1 — ChirpStack Infrastructure
**Goal:** ChirpStack running alongside the existing stack; gateways and devices registered; uplinks visible in ChirpStack UI.

- [ ] Add `chirpstack/chirpstack.toml` config file
- [ ] Add `chirpstack/region_eu868.toml` (and any other required regions)
- [ ] Add `chirpstack-gateway-bridge`, `chirpstack`, `redis` to `docker-compose.yml`
- [ ] Create `chirpstack` database in PostgreSQL (or configure ChirpStack to auto-migrate into it)
- [ ] Register gateways in ChirpStack UI
- [ ] Register AirVibe devices in ChirpStack (DevEUI, AppKey, frequency plan)
- [ ] Validate: uplinks visible in ChirpStack live frame log

**Validation checkpoint:** Power cycle an AirVibe device and see its join request and subsequent uplinks appear in the ChirpStack device frame log.

### Phase 2 — Message Normalization Adapter
**Goal:** Backend receives and correctly parses ChirpStack-format uplinks; MQTT monitor displays them.

- [ ] Create `backend/src/adapters/chirpstack.js` (translate ChirpStack JSON → internal canonical format, base64 → hex)
- [ ] Modify `backend/src/mqttClient.js` to subscribe to `application/+/device/+/event/up` and run messages through adapter before dispatch
- [ ] Modify publish path in `mqttClient.js` to emit ChirpStack downlink format to correct topic
- [ ] Update `DemoSimulator.js` to generate ChirpStack-format mock messages
- [ ] Update `CHIRPSTACK_APPLICATION_ID` env var handling in `index.js`

**Validation checkpoint:** MQTT Monitor tab displays live AirVibe uplinks. Manually send a downlink from the UI and verify it appears in ChirpStack's downlink queue for the device.

### Phase 3 — ChirpStack Client (Class C Switching)
**Goal:** FUOTA Manager can switch device class without ThingPark.

- [ ] Create `backend/src/services/ChirpStackClient.js` (REST API, API key auth, setDeviceClass method)
- [ ] Modify `backend/src/services/FUOTAManager.js` to import `ChirpStackClient` in place of `ThingParkClient`
- [ ] Modify `backend/src/index.js`: remove ThingPark status endpoint, add network-server status endpoint
- [ ] Modify `frontend/src/components/FUOTAManager.tsx`: rename ThingPark references

**Validation checkpoint:** Start a FUOTA session. Observe in ChirpStack UI that the device's class changes to C at session start and back to A at completion.

### Phase 4 — Cleanup & Simplification
**Goal:** Remove all Actility artifacts; update config and documentation.

- [ ] Delete `backend/src/services/ThingParkClient.js`
- [ ] Update `.env.example`: remove ThingPark vars, add ChirpStack vars
- [ ] Update `Caddyfile` to use `tls internal`
- [ ] Update `CLAUDE.md` architecture description
- [ ] Update `README.md` deployment instructions

### Phase 5 — End-to-End Validation
**Goal:** Confirm full feature parity with the Actility-connected deployment.

- [ ] MQTT Monitor: live uplinks visible and color-coded correctly
- [ ] Waveform Manager: full waveform capture, assembly, and display from at least one AirVibe device
- [ ] Downlink Builder: manual downlink successfully reaches device (confirm via AirVibe device response)
- [ ] FUOTA Manager: complete firmware update cycle from init through verify with a real firmware file
- [ ] Certificate Manager: generate and download client certs (PKI system unchanged)
- [ ] Caddy: HTTPS accessible on LAN with `tls internal` cert; no Let's Encrypt outbound calls

---

## 14. What This Deployment Does Not Require

To be explicit about what is removed from operational requirements:

- No Actility/ThingPark account or license
- No public internet access (after initial Docker image pull)
- No public DNS record or domain name
- No Let's Encrypt certificate provisioning
- No outbound OAuth2 token requests (ThingPark DX Core API)
- No cloud MQTT bridge (Actility pushed uplinks over internet; ChirpStack is co-located)
- No VPS — any Linux machine on the LAN works (Raspberry Pi 4+, Intel NUC, industrial PC, NAS)

---

## 15. Open Questions Before Implementation

The following should be resolved before Phase 1 begins:

1. **Frequency plan:** Which LoRaWAN region(s) do the deployed AirVibe devices use? (EU868, US915, AU915, AS923, IN865?) ChirpStack region config files must match the device frequency plan.

2. **Join mode:** Are devices using OTAA (Over-the-Air Activation with AppKey) or ABP (Activation By Personalization with pre-provisioned session keys)? OTAA is strongly preferred and what ChirpStack defaults to.

3. **Gateway count and model:** How many gateways per site? What make/model? (Needed to confirm packet forwarder compatibility and whether Basics Station migration is worthwhile.)

4. **Concurrent sites:** Is this a single-site deployment or does it need to support multiple independent sites, each with their own Docker stack? (Single-stack per site is the simplest model and is assumed here.)

5. **Remote access preference:** Tailscale vs. WireGuard vs. Cloudflare Tunnel — customer IT policy may dictate this choice.

6. **ChirpStack database isolation:** Should ChirpStack use a separate PostgreSQL database (`chirpstack`) within the existing `postgres` container, or a separate container? Sharing the container (separate database) is simpler and assumed here.
