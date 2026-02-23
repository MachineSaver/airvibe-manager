# Deployment Log — AirVibe Waveform Manager

Running log of issues, ambiguities, and documentation gaps encountered during
testing and deployment. Each entry includes a status and the action taken or
needed.

---

## Session 1 — 2026-02-23: Initial Cloud Deployment to air.machinesaver.com

### Environment
- VPS: Linode Ubuntu 24.04.3 LTS (x86-64), 45.33.2.123
- Domain: air.machinesaver.com (Cloudflare DNS-only A record)
- Mode: ThingPark / cloud (`NETWORK_SERVER=thingpark`)
- Docker: 29.2.1, Docker Compose: v5.0.2

---

### Issue 1 — Port 4000 exposed publicly (Security) ✅ Fixed
**Severity:** High
**File:** `docker-compose.yml`

The backend service was bound as `"4000:4000"`, which maps to `0.0.0.0:4000`
on the host. Docker inserts iptables FORWARD rules that bypass UFW for
`0.0.0.0` bindings, meaning port 4000 was reachable from the internet even
with `ufw default deny incoming` configured.

The raw backend API has no authentication layer — exposing it directly
bypasses Caddy's HTTPS/TLS termination and allows unauthenticated API calls
from the public internet.

Caddy reaches the backend via Docker's internal network service name
(`backend:4000`) and does not need a host port mapping at all. The binding
exists only as a local-dev convenience.

**Fix applied:** Changed `"4000:4000"` → `"127.0.0.1:4000:4000"`. Docker will
only bind the loopback interface on the host; the public-facing iptables
FORWARD rule is not created. Caddy-to-backend traffic over the Docker bridge
is unaffected.

---

### Issue 2 — README ThingPark FUOTA section is stale ✅ Needs README update
**Severity:** Medium (misleads operators)
**Files:** `README.md` (§ThingPark Initial Setup step 5, §Enabling FUOTA Class C Auto-Switch Cloud section)

Both sections state that automatic Class C switching is **not available** in
ThingPark mode and require manual profile changes in the ThingPark portal
before every FUOTA session.

This was true before commit `499a9be` (2026-02-23) which restored
`ThingParkClient.js` and wired it into `networkServerClient.js`. ThingPark
Class C auto-switch is now available when `THINGPARK_CLIENT_ID` and
`THINGPARK_CLIENT_SECRET` are set.

**Action needed:** Update README §ThingPark Initial Setup step 5 and
§Enabling FUOTA Class C Auto-Switch Cloud section to document the new
automatic switch capability and the required env vars.

---

### Issue 3 — `setup_vps.sh` not suitable for ThingPark/cloud deployment
**Severity:** Medium
**File:** `scripts/setup_vps.sh`

The script creates a minimal `.env` with only `DOMAIN`, `NEXT_PUBLIC_API_URL`,
`MQTT_USER`, and `MQTT_PASS`. It does not set:
- `NETWORK_SERVER`
- `COMPOSE_PROFILES`
- `MQTT_BROKER_URL`

Running it for a ThingPark deployment would produce a misconfigured `.env`
that defaults to `NETWORK_SERVER=chirpstack` (ChirpStack mode, wrong adapter)
and starts with the wrong MQTT broker URL. A developer following the README
might be tempted to run this script — it would silently produce a broken
deployment.

The script also starts `docker compose up -d --build` at the end without
prompting for credentials, and `docker compose` is called with `sudo` which
may fail in environments where the non-root user runs Docker.

**Action needed:** Either extend `setup_vps.sh` to support both modes with
a deployment-mode prompt, or add a prominent warning in the README that
`setup_vps.sh` is for on-premise mode only.

---

### Issue 4 — ThingPark MQTT endpoint hostname may not resolve from container
**Severity:** Low (expected at this stage — no credentials set)
**Observed during:** Initial backend startup

Backend logs showed `ENOTFOUND lora-eu868-devices.thingpark.com` from inside
the Docker container. The hostname `lora-eu868-devices.thingpark.com` is the
standard EU868 ThingPark MQTT endpoint used as a placeholder in `.env`.

This could indicate:
1. The placeholder hostname is not the correct endpoint for this account — the
   actual broker URL must be copied from the ThingPark portal.
2. Transient DNS resolution issue inside the Docker bridge network on first
   startup.

Since no ThingPark credentials are set, the reconnect loop is expected behavior
per the README. The actual endpoint will be confirmed when credentials are
provided by the operator.

**Action needed (user):** In ThingPark portal → Network → MQTT API, copy the
exact broker URL and paste it into `.env` as `MQTT_BROKER_URL`. Then provide
`MQTT_USER` and `MQTT_PASS` and run `docker compose up -d` (no rebuild needed
for these vars since they are not baked into the frontend bundle).

---

### Issue 5 — README Project Structure lists wrong ChirpStack region filename
**Severity:** Low (documentation only)
**File:** `README.md` (§Project Structure)

README lists `region_us915.toml` — actual filename on disk is
`region_us915_0.toml`. This mismatch was already corrected in `CLAUDE.md`
(commit `bc56625`) but the README Project Structure tree was not updated.

**Action needed:** Update README project structure tree.

---

### Issue 6 — npm audit vulnerabilities in build output
**Severity:** Low (pre-existing, non-blocking)

During `docker compose up --build`:
- **Backend:** 3 high severity vulnerabilities reported by `npm audit`
- **Frontend:** 1 moderate, 14 high, 1 critical vulnerabilities reported

These appear to be pre-existing in the dependency tree and do not block the
build. Should be tracked and resolved in a separate dependency audit pass.

**Action needed:** Run `npm audit fix` in both `backend/` and `frontend/` and
review what upgrades are available without breaking changes.

---

### Issue 7 — `baseline-browser-mapping` data staleness warning during frontend build
**Severity:** Informational
**Observed during:** `docker compose build` frontend stage

The Next.js build emitted: `warn - The browserslist data in the
baseline-browser-mapping module is over two months old.`

This is a cosmetic warning from the Browserslist package used for CSS/JS
transpilation targeting. It does not affect functionality.

**Action needed:** Update Browserslist data with `npx update-browserslist-db@latest`
or upgrade the `baseline-browser-mapping` / `browserslist` package versions.

---

## Deployment Outcome — Session 1

| Check | Result |
|---|---|
| SSH access | ✅ Accessible |
| Docker installed | ✅ 29.2.1 / Compose v5.0.2 |
| All 4 app-only containers running | ✅ Up, postgres healthy |
| Correct network server mode | ✅ "MQTT adapter: thingpark" confirmed in logs |
| Correct profile (no ChirpStack containers) | ✅ Only 4 containers |
| Database schema initialized | ✅ Confirmed in backend logs |
| PKI initialized for domain | ✅ Confirmed in backend logs |
| Let's Encrypt TLS certificate | ✅ Issued for air.machinesaver.com |
| HTTPS accessible | ✅ https://air.machinesaver.com |
| MQTT connection (ThingPark) | ⏳ Reconnect loop — awaiting credentials |
| Port 4000 security fix | ✅ Fixed and deployed |

---

## Pending — Actility ThingPark Integration

The following information is needed from the operator before MQTT data flow
can be tested:

1. **ThingPark MQTT broker URL** — from ThingPark portal → Network → MQTT API
   (e.g. `mqtts://lora-eu868-devices.thingpark.com:8883`)

2. **MQTT credentials** — ThingPark portal → Users → your user → MQTT credentials
   Set as `MQTT_USER` and `MQTT_PASS` in `/root/mqtt-manager/.env` on the VPS.

3. **Confirmation of provisioned devices** — DevEUIs and AppKeys registered in
   ThingPark. Device uplinks will appear in the MQTT Monitor tab once the
   connection is established.

Once credentials are set, apply with:
```bash
# SSH to VPS
cd /root/mqtt-manager
# Edit .env: set MQTT_BROKER_URL, MQTT_USER, MQTT_PASS
docker compose up -d   # No rebuild needed — these vars are not baked into frontend
docker compose logs -f mqtt-manager-backend | grep -E "MQTT|Connected|Error"
```

No `--build` is required for credential changes since `MQTT_BROKER_URL`,
`MQTT_USER`, and `MQTT_PASS` are passed as environment variables at runtime,
not baked into the image.
