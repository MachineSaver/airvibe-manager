# AirVibe Waveform Manager — On-Premise Edition

A fully self-contained Docker stack for managing AirVibe vibration sensors over LoRaWAN — **no cloud account, no external network server, no internet required at runtime.**

This branch (`on_premise`) replaces Actility ThingPark with **ChirpStack v4**, an open-source LoRaWAN Network Server + Application Server that runs entirely inside Docker alongside the rest of the application. A single `docker compose up` gives you a complete edge deployment ready for an industrial LAN or VPN.

> **Looking for the cloud/Actility-connected version?** See the `main` branch.

---

## Features

| Feature | Description |
|---|---|
| **MQTT Monitor** | Real-time view of all MQTT traffic on the broker — uplinks, downlinks, gateway stats |
| **Waveform Manager** | Captures, assembles, and exports AirVibe waveform captures (JSON + CSV download) |
| **FUOTA Manager** | Firmware-over-the-air updates with block transmission, verify/retry, and Class A↔C auto-switching via ChirpStack API |
| **Certificate Manager** | Generates CA, server, and client X.509 certificates for MQTT TLS |
| **ChirpStack UI** | Full LoRaWAN network management: gateways, devices, applications, live frame log |
| **Demo Mode** | Built-in simulator for testing the full UI without real hardware |

---

## Architecture

```
LoRaWAN Gateway  ─── UDP:1700 ──▶  chirpstack-gateway-bridge
                                           │  MQTT (internal)
                                           ▼
                                  mqtt-broker (Mosquitto)
                                 ╱                        ╲
                       chirpstack (LNS+AS)         backend (Express + Socket.io)
                            │                             │
                          postgres  ◀────────────────▶  postgres
                          redis                          │  WebSocket
                                                         ▼
                                                   frontend (Next.js)
                                                         │
                                           Caddy (TLS — tls internal)
                                                         │
                                                  Browser / UI
```

**Data flow (uplink):**
1. AirVibe sensor → Gateway → Gateway Bridge (UDP:1700) → Mosquitto
2. ChirpStack subscribes to gateway topics, handles MAC layer, decrypts application payload
3. ChirpStack publishes decoded uplink to Mosquitto: `application/{id}/device/{devEUI}/event/up`
4. Backend adapter normalizes ChirpStack message → internal canonical format
5. WaveformManager + FUOTAManager process the canonical message
6. Frontend receives events over Socket.io and renders them in all three management tabs

**Data flow (downlink):**
Frontend → Socket.io → Backend (builds internal downlink) → Adapter (translates to ChirpStack format) → Mosquitto → ChirpStack → Gateway → AirVibe device

---

## Requirements

- **Docker** and **Docker Compose** v2 (`docker compose` not `docker-compose`)
- **LoRaWAN gateway** with Semtech UDP Packet Forwarder (RAK, Dragino, Kerlink, MultiTech, Tektelic, etc.)
- **AirVibe sensors** provisioned with DevEUI + AppKey (for OTAA join)
- A Linux host on the same LAN as the gateway — any x86-64 machine works (PC, Intel NUC, industrial computer, Raspberry Pi 5, NAS with Docker support)

No internet access is required at runtime. Internet is only needed for the initial `docker compose pull` to download container images.

---

## Quick Start

### 1. Clone and configure

```bash
git clone <repo-url>
cd AirVibe_Waveform_Manager
git checkout on_premise

cp .env.example .env
# Edit .env if needed — defaults work for localhost development
```

### 2. Start the full stack

```bash
docker compose up -d --build
```

This starts all eight services. **First boot takes ~60 seconds** while ChirpStack runs its initial database migrations.

Watch startup:
```bash
docker compose logs -f chirpstack
# Wait for: "starting api server" — then ChirpStack is ready
```

### 3. Access the services

| Service | URL | Credentials |
|---|---|---|
| **AirVibe UI** | `https://localhost` | — |
| **ChirpStack UI** | `http://localhost:8080` | `admin` / `admin` (change immediately) |

The AirVibe UI uses a self-signed certificate from Caddy's built-in CA. See [TLS Setup](#tls-setup) to trust it in your browser.

---

## ChirpStack Initial Setup

Open `http://localhost:8080` (or `http://<host-ip>:8080` from another machine on the LAN).

### 1. Change the admin password
Account → Change Password

### 2. Create a Device Profile
Tenants → your tenant → Device Profiles → Add Device Profile

| Setting | Value |
|---|---|
| Name | e.g. `AirVibe-EU868` |
| Region | EU868 (or US915 to match your hardware) |
| MAC version | LoRaWAN 1.0.3 |
| Regional parameters | RevA |
| ADR algorithm | default |
| Supports OTAA | ✅ enabled |

### 3. Create an Application
Applications → Add Application (name it anything — e.g. "AirVibe Production")

Note the **Application ID** from the URL — you'll need it for `CHIRPSTACK_APPLICATION_ID` in `.env`.

### 4. Add your gateway
Network → Gateways → Add Gateway

Enter your gateway's EUI (usually printed on the hardware or in its web UI).

**On the gateway hardware**, set the packet forwarder server to:
```
Server address: <this-host-LAN-IP>
Port up: 1700
Port down: 1700
```

The gateway should appear as "Online" within ~30 seconds.

### 5. Register your AirVibe devices
Applications → your application → Add Device

| Field | Value |
|---|---|
| Name | Descriptive name (e.g. "Pump House - Sensor A") |
| Device EUI | 16-digit hex EUI from the device label |
| Device Profile | The profile created in step 2 |

After creating the device, go to **Keys (OTAA)** and enter the **Application Key** (AppKey). Power-cycle the AirVibe sensor to trigger a join request — it should appear as "Active" in the device list.

---

## Enabling FUOTA Class C Auto-Switch

Without this, FUOTA still works — you just manually set class to C in ChirpStack before each session and back to A after.

**Generate an API key in ChirpStack:**

API Keys → Create API Key → copy the token

**Add to `.env`:**
```bash
CHIRPSTACK_API_KEY=your-api-key-here
CHIRPSTACK_APPLICATION_ID=1   # from the ChirpStack application URL
```

**Restart the backend:**
```bash
docker compose restart backend
```

The FUOTA Manager tab will now show a green "ChirpStack Class C auto-switch enabled" banner.

---

## TLS Setup

Caddy uses `tls internal` — it is its own certificate authority and issues a certificate for `DOMAIN` without requiring any public DNS or internet access.

**To eliminate the browser warning (one-time per machine):**

```bash
# Export Caddy's root CA
docker exec mqtt-manager-caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-root-ca.crt
```

Import `caddy-root-ca.crt` into your OS trust store:

| OS | Steps |
|---|---|
| **macOS** | Double-click → Keychain Access → set trust to "Always Trust" |
| **Windows** | Double-click → Install Certificate → Local Machine → Trusted Root Certification Authorities |
| **Ubuntu/Debian** | `sudo cp caddy-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates` |
| **Firefox** | Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import |

---

## Remote Access Options

For access from outside the local network without exposing ports to the internet:

| Option | Effort | Notes |
|---|---|---|
| **Tailscale** | Very low | Install on the host (`curl -fsSL https://tailscale.com/install.sh \| sh && sudo tailscale up`). Access via Tailscale IP or MagicDNS. No firewall changes needed. **Recommended.** |
| **WireGuard** | Medium | Full control. Can be added as an additional Docker service (`linuxserver/wireguard`). |
| **Cloudflare Tunnel** | Low | Routes through Cloudflare's edge. Free tier available. Requires Cloudflare account. |

---

## Gateway Compatibility

The Gateway Bridge supports all major commercial gateways without firmware changes:

| Protocol | Port | Gateways |
|---|---|---|
| Semtech UDP Packet Forwarder | 1700/UDP | RAK, Dragino, Kerlink, Tektelic, MultiTech, Laird, most others |
| Basics Station (LNS) | configurable | RAK (newer FW), Semtech Corecell, others with BS support |

To use Basics Station instead of UDP, update `chirpstack/chirpstack-gateway-bridge.toml` and change `[backend]` type to `basic_station`.

---

## Development

### Local development (without Docker)

Requirements: Node.js 20+, PostgreSQL, Mosquitto, and a running ChirpStack instance.

```bash
# Terminal 1 — Backend
cd backend
npm install
# Set these in your shell or a local .env:
#   POSTGRES_HOST=localhost  POSTGRES_PASSWORD=postgres
#   MQTT_BROKER_URL=mqtt://localhost:1883
#   CHIRPSTACK_API_URL=http://localhost:8080  CHIRPSTACK_API_KEY=...
npm run dev    # nodemon auto-reload on port 4000

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev    # Next.js dev server on port 3000
```

### Lint and build

```bash
cd frontend
npm run lint    # ESLint 9 flat config, next/core-web-vitals
npm run build   # Production Next.js build
```

### Running only ChirpStack locally (for development)

You can run just the LoRaWAN infrastructure in Docker and develop the app locally:

```bash
docker compose up -d chirpstack-gateway-bridge chirpstack redis mqtt-broker postgres
```

Then run the backend and frontend with `npm run dev` as above.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DOMAIN` | `localhost` | Hostname for Caddy TLS and CORS |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Browser-accessible backend URL |
| `POSTGRES_USER` | `postgres` | PostgreSQL username |
| `POSTGRES_PASSWORD` | `postgres` | PostgreSQL password |
| `POSTGRES_DB` | `airvibe` | AirVibe application database |
| `MQTT_USER` | _(none)_ | Optional Mosquitto username |
| `MQTT_PASS` | _(none)_ | Optional Mosquitto password |
| `CHIRPSTACK_API_URL` | `http://chirpstack:8080` | ChirpStack internal REST API URL |
| `CHIRPSTACK_API_KEY` | _(none)_ | API key for FUOTA Class C auto-switch |
| `CHIRPSTACK_APPLICATION_ID` | `1` | ChirpStack application ID |

---

## Project Structure

```
├── Caddyfile                       # Reverse proxy (tls internal for LAN)
├── docker-compose.yml              # 8-service stack
├── .env.example                    # Environment template
├── ON_PREMISE_SWITCHOVER.md        # Architecture decision record
├── chirpstack/
│   ├── chirpstack.toml             # ChirpStack main config
│   ├── chirpstack-gateway-bridge.toml  # Gateway bridge config
│   ├── region_eu868.toml           # EU868 channel plan
│   └── region_us915.toml           # US915 sub-band 2 channel plan
├── backend/
│   └── src/
│       ├── index.js                # Express server, Socket.io, REST API
│       ├── mqttClient.js           # MQTT broker connection + adapter wiring
│       ├── pki.js                  # X.509 certificate generation
│       ├── db.js                   # PostgreSQL connection pool
│       ├── db/schema.sql           # Database schema
│       ├── adapters/
│       │   └── chirpstack.js       # ChirpStack ↔ internal format adapter
│       └── services/
│           ├── ChirpStackClient.js # Class A↔C switching via ChirpStack REST API
│           ├── WaveformManager.js  # Waveform packet processing and assembly
│           ├── FUOTAManager.js     # Firmware update state machine
│           ├── MessageTracker.js   # Message persistence and device registry
│           ├── DemoSimulator.js    # Demo mode (emits ChirpStack-format messages)
│           └── AuditLogger.js      # Audit log persistence
├── frontend/
│   └── src/
│       ├── app/
│       │   ├── page.tsx            # Main tabbed UI
│       │   └── SocketContext.tsx   # Socket.io React context
│       └── components/
│           ├── MQTTMessageCard.tsx # Collapsible message display
│           ├── DownlinkBuilder.tsx # Downlink command builder
│           ├── FUOTAManager.tsx    # FUOTA UI
│           ├── WaveformsView.tsx   # Waveform list and viewer
│           └── WaveformChart.tsx   # Tri-axial chart
├── mosquitto/
│   ├── config/mosquitto.conf       # Broker config (1883 plain + 8883 TLS)
│   └── watcher.sh                  # Auto-restart on cert changes
└── certs/                          # Generated X.509 certificates
```

---

## Troubleshooting

**Gateway not appearing in ChirpStack**
```bash
# Check gateway bridge is receiving UDP frames
docker logs chirpstack-gateway-bridge
# Verify port 1700/UDP is open from gateway
nc -u <host-ip> 1700   # should not refuse connection
```

**No uplinks in MQTT Monitor after join**
```bash
# Check ChirpStack event log for the device
# ChirpStack UI → Applications → device → Event Log
docker logs chirpstack   # look for errors
```

**FUOTA Class C switch not happening**
```bash
docker logs mqtt-manager-backend | grep ChirpStack
# If "not configured" — add CHIRPSTACK_API_KEY to .env and restart backend
```

**Browser certificate warning**
Follow the [TLS Setup](#tls-setup) section to import Caddy's root CA, or access via HTTP on port 80 for development.

**ChirpStack login fails**
- Default: `admin` / `admin`
- If changed and forgotten: `docker compose exec chirpstack /usr/bin/chirpstack user set-password --username admin --password newpassword`

**Mosquitto port 8883 (TLS) fails to start**
Generate certificates via the AirVibe UI (Certificate Management tab) first, then:
```bash
docker compose restart mqtt-broker
```

---

## Updating

```bash
git pull
docker compose pull
docker compose up -d --build
```

ChirpStack runs database migrations automatically on startup.

---

## Docker Services Reference

| Container | Image | Exposed Port(s) | Purpose |
|---|---|---|---|
| `chirpstack-gateway-bridge` | `chirpstack/chirpstack-gateway-bridge:4` | 1700/UDP | Translates gateway UDP frames to MQTT |
| `chirpstack` | `chirpstack/chirpstack:4` | 8080 (web UI + REST API) | LoRaWAN Network + Application Server |
| `chirpstack-redis` | `redis:7-alpine` | internal | ChirpStack session state |
| `mqtt-broker` | `eclipse-mosquitto:2` | 1883, 8883 | MQTT broker |
| `mqtt-manager-postgres` | `postgres:16-alpine` | internal | AirVibe + ChirpStack databases |
| `mqtt-manager-backend` | (built) | internal | Express API + Socket.io |
| `mqtt-manager-frontend` | (built) | internal | Next.js UI |
| `mqtt-manager-caddy` | `caddy:alpine` | 80, 443 | HTTPS reverse proxy |
