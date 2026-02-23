#!/usr/bin/env bash
# smoke-test.sh — end-to-end profile smoke tests
#
# Tests both the "full" profile (8 services) and the "app-only" profile
# (4 services) against a live Docker environment.
#
# Usage: ./scripts/smoke-test.sh
# Exit:  0 on all checks passing, non-zero on first failure.
#
# Requirements: docker compose v2, curl, mosquitto_pub (optional for MQTT check)

set -euo pipefail
cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS=0
FAIL=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        pass "$label"
    else
        fail "$label (expected '$expected', got '$actual')"
    fi
}

assert_contains() {
    local label="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -q "$needle"; then
        pass "$label"
    else
        fail "$label (expected to contain '$needle')"
    fi
}

assert_http() {
    local label="$1" url="$2" expected_code="${3:-200}"
    local actual
    actual=$(curl -sk -o /dev/null -w '%{http_code}' "$url" || echo "000")
    assert_eq "$label" "$expected_code" "$actual"
}

container_running() {
    docker inspect --format '{{.State.Status}}' "$1" 2>/dev/null | grep -q '^running$'
}

container_exists() {
    docker inspect "$1" &>/dev/null
}

wait_http() {
    local url="$1" max="${2:-60}" interval=3 elapsed=0
    until curl -sk -o /dev/null -w '%{http_code}' "$url" | grep -qE '^[23]'; do
        sleep "$interval"
        elapsed=$((elapsed + interval))
        if [ "$elapsed" -ge "$max" ]; then
            echo "  [timeout] $url did not respond within ${max}s" >&2
            return 1
        fi
    done
}

teardown() {
    echo ""
    echo "--- Teardown ---"
    COMPOSE_PROFILES=full docker compose down -v --remove-orphans 2>/dev/null || true
}
trap teardown EXIT

# ---------------------------------------------------------------------------
# Full profile
# ---------------------------------------------------------------------------

echo ""
echo "======================================================="
echo " FULL PROFILE smoke test  (COMPOSE_PROFILES=full)"
echo "======================================================="

COMPOSE_PROFILES=full docker compose up -d --build --wait 2>&1 | tail -5

echo ""
echo "--- Container checks ---"

for svc in \
    mqtt-manager-postgres \
    chirpstack-redis \
    mqtt-broker \
    chirpstack \
    chirpstack-gateway-bridge \
    mqtt-manager-backend \
    mqtt-manager-frontend \
    mqtt-manager-caddy
do
    if container_running "$svc"; then
        pass "$svc is running"
    else
        fail "$svc is not running"
    fi
done

RUNNING_COUNT=$(docker compose ps --format '{{.Name}}' | wc -l | tr -d ' ')
assert_eq "exactly 8 containers running" "8" "$RUNNING_COUNT"

echo ""
echo "--- Service health checks ---"

# Postgres: airvibe DB accessible
if docker exec mqtt-manager-postgres psql -U postgres -d airvibe -c '\q' &>/dev/null; then
    pass "Postgres airvibe DB accessible"
else
    fail "Postgres airvibe DB not accessible"
fi

# ChirpStack DB: schema was migrated (at least 20 tables expected)
CS_TABLE_COUNT=$(docker exec mqtt-manager-postgres psql -U postgres -d chirpstack -t -c \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d ' ')
if [ "${CS_TABLE_COUNT:-0}" -ge 20 ]; then
    pass "ChirpStack DB migrated (${CS_TABLE_COUNT} tables)"
else
    fail "ChirpStack DB migration incomplete (${CS_TABLE_COUNT} tables, expected ≥20)"
fi

# Wait for backend to be ready (it may take a few seconds after ChirpStack starts)
echo "  waiting for backend /health ..."
wait_http "http://localhost:4000/api/health" 60 || true

assert_http "Backend GET /health → 200" "http://localhost:4000/api/health" "200"

# ChirpStack UI
assert_http "ChirpStack UI GET http://localhost:8080 → 200" "http://localhost:8080" "200"

# Demo API
DEMO_RESP=$(curl -sk "http://localhost:4000/api/demo/status" || echo '{}')
assert_contains "Demo API returns JSON with 'running'" '"running"' "$DEMO_RESP"

# MQTT broker: port 1883 open
if docker exec mqtt-broker mosquitto_pub -h localhost -t smoke-test -n 2>/dev/null; then
    pass "Mosquitto port 1883 accepts connections"
else
    # Fallback: just check the port is open
    if docker exec mqtt-broker nc -z localhost 1883 &>/dev/null 2>&1; then
        pass "Mosquitto port 1883 open (nc check)"
    else
        fail "Mosquitto port 1883 not accepting connections"
    fi
fi

# AirVibe UI via Caddy TLS
assert_http "AirVibe UI TLS GET https://localhost → 200" "https://localhost" "200"

# Mosquitto publish test
docker compose down -v --remove-orphans 2>/dev/null || true

# ---------------------------------------------------------------------------
# App-only profile
# ---------------------------------------------------------------------------

echo ""
echo "======================================================="
echo " APP-ONLY PROFILE smoke test  (COMPOSE_PROFILES=)"
echo "======================================================="
echo "  (Backend will log MQTT errors — this is expected)"

# Use an unreachable MQTT URL so the backend starts cleanly but MQTT fails
COMPOSE_PROFILES= MQTT_BROKER_URL=mqtt://localhost:9999 docker compose up -d --build 2>&1 | tail -5

# Give services a moment to start (no --wait: not all services have healthchecks)
sleep 10

echo ""
echo "--- Container checks ---"

for svc in mqtt-manager-postgres mqtt-manager-backend mqtt-manager-frontend mqtt-manager-caddy; do
    if container_running "$svc"; then
        pass "$svc is running"
    else
        fail "$svc is not running"
    fi
done

APP_ONLY_COUNT=$(docker compose ps --format '{{.Name}}' | wc -l | tr -d ' ')
assert_eq "exactly 4 containers running" "4" "$APP_ONLY_COUNT"

echo ""
echo "--- Absent services check (must NOT exist) ---"

for svc in chirpstack chirpstack-redis chirpstack-gateway-bridge mqtt-broker; do
    if ! container_exists "$svc"; then
        pass "$svc does not exist"
    else
        fail "$svc exists but should not in app-only mode"
    fi
done

echo ""
echo "--- Service health checks ---"

# Backend should log MQTT errors but still serve HTTP
BACKEND_LOGS=$(docker logs mqtt-manager-backend 2>&1 || true)
assert_contains "Backend logs show MQTT error (expected)" "MQTT Error" "$BACKEND_LOGS"

# Backend REST API should still respond
echo "  waiting for backend /health ..."
wait_http "http://localhost:4000/api/health" 60 || true

assert_http "Backend GET /health → 200" "http://localhost:4000/api/health" "200"

# AirVibe UI
assert_http "AirVibe UI TLS GET https://localhost → 200" "https://localhost" "200"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "======================================================="
echo " Results: ${PASS} passed, ${FAIL} failed"
echo "======================================================="

if [ "$FAIL" -gt 0 ]; then
    echo "SMOKE TEST FAILED" >&2
    exit 1
fi

echo "All smoke tests passed."
