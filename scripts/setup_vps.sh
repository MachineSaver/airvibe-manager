#!/bin/bash
# =============================================================================
# AirVibe Waveform Manager — VPS Setup Script
# =============================================================================
# Usage:
#   chmod +x setup_vps.sh && ./setup_vps.sh
#
# Supports both deployment modes:
#   ChirpStack (on-premise) — bundles the full LoRaWAN stack
#   ThingPark  (cloud)      — app-only; ThingPark connects to bundled Mosquitto
#
# NOTE: This script is designed to run as root (typical for a fresh VPS).
#       If running as a non-root user with Docker group membership, remove
#       'sudo' from the docker commands at the bottom.
# =============================================================================

set -e

echo "=========================================="
echo "   AirVibe Waveform Manager — VPS Setup"
echo "=========================================="

# 1. Update system & install dependencies
echo ""
echo "[1/5] Updating system and installing dependencies..."
apt-get update -qq
apt-get install -y git curl ufw

# 2. Install Docker (if not found)
if ! command -v docker &>/dev/null; then
    echo ""
    echo "[2/5] Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    echo "Docker installed."
else
    echo ""
    echo "[2/5] Docker already installed ($(docker --version))."
fi

# 3. Clone or update repository
REPO_URL="https://github.com/MachineSaver/mqtt-manager.git"
DIR_NAME="mqtt-manager"

echo ""
if git rev-parse --is-inside-work-tree &>/dev/null; then
    echo "[3/5] Already inside the repository — pulling latest..."
    cd "$(git rev-parse --show-toplevel)"
    git pull
elif [ -d "$DIR_NAME" ]; then
    echo "[3/5] Directory '$DIR_NAME' exists — pulling latest..."
    cd "$DIR_NAME"
    git pull
else
    echo "[3/5] Cloning repository..."
    git clone "$REPO_URL"
    cd "$DIR_NAME"
fi

# 4. Configure environment
echo ""
echo "[4/5] Configuring environment..."

if [ -f .env ]; then
    echo ".env already exists — skipping creation."
    DOMAIN_INPUT=$(grep ^DOMAIN= .env | cut -d= -f2)
    MODE=$(grep ^NETWORK_SERVER= .env | cut -d= -f2)
    MODE=${MODE:-chirpstack}
else
    echo ""
    echo "Deployment mode:"
    echo "  1) ChirpStack (on-premise) — bundles ChirpStack, Mosquitto, Redis, gateway bridge"
    echo "  2) ThingPark  (cloud)      — app-only; ThingPark pushes data to bundled Mosquitto"
    echo ""
    read -rp "Select mode [1/2]: " MODE_CHOICE

    read -rp "Domain (e.g. airvibe.yourcompany.com or localhost): " DOMAIN_INPUT

    if [ "$MODE_CHOICE" = "2" ]; then
        MODE="thingpark"
        PROFILES=""
        cat <<EOF > .env
NETWORK_SERVER=thingpark
COMPOSE_PROFILES=
DOMAIN=$DOMAIN_INPUT
NEXT_PUBLIC_API_URL=https://$DOMAIN_INPUT
# MQTT_BROKER_URL defaults to mqtt://mqtt-broker:1883 — do not change for ThingPark.
# ThingPark X IoT Flow connects TO our Mosquitto on port 8883 (mTLS).
# Generate certificates in the Credentials Manager tab and configure a
# ThingPark X IoT Flow MQTT connector pointing at mqtts://$DOMAIN_INPUT:8883.
MQTT_BROKER_URL=mqtt://mqtt-broker:1883
MQTT_USER=
MQTT_PASS=
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=airvibe
# ThingPark API — enables automatic Class C profile switching for FUOTA.
# Generate OAuth2 client credentials in ThingPark portal → DX Admin → Applications.
THINGPARK_BASE_URL=https://community.thingpark.io
# THINGPARK_CLIENT_ID=
# THINGPARK_CLIENT_SECRET=
# THINGPARK_CLASS_C_PROFILE=LORA/GenericC.1.0.4a_ETSI
EOF
    else
        MODE="chirpstack"
        PROFILES="full"
        cat <<EOF > .env
NETWORK_SERVER=chirpstack
COMPOSE_PROFILES=full
DOMAIN=$DOMAIN_INPUT
NEXT_PUBLIC_API_URL=https://$DOMAIN_INPUT
MQTT_BROKER_URL=mqtt://mqtt-broker:1883
MQTT_USER=
MQTT_PASS=
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=airvibe
CHIRPSTACK_API_URL=http://chirpstack:8080
# CHIRPSTACK_API_KEY=
CHIRPSTACK_APPLICATION_ID=1
EOF
    fi
    echo ".env created for $MODE mode."
fi

# 5. Firewall & startup
echo ""
echo "[5/5] Configuring firewall and starting services..."

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (ACME challenge / redirect)
ufw allow 443/tcp   # HTTPS
# Port 1883 (plain MQTT) is intentionally NOT opened — it is bound to
# 127.0.0.1 inside Docker and should never be reachable from the internet.
ufw allow 8883/tcp  # MQTT over TLS — required for ThingPark inbound connector
ufw --force enable

echo ""
echo "Starting stack (./build.sh stamps git hash + build timestamp into the UI footer)..."
chmod +x build.sh
./build.sh

echo ""
echo "=========================================="
echo "   Setup Complete!"
echo "=========================================="
echo "  Web UI:       https://$DOMAIN_INPUT"
echo "  MQTT (TLS):   $DOMAIN_INPUT:8883"
echo "  Mode:         $MODE"
echo ""
if [ "$MODE" = "thingpark" ]; then
    echo "  Next steps:"
    echo "  1. Open https://$DOMAIN_INPUT → Credentials Manager tab"
    echo "  2. Download CA cert, client cert, and private key"
    echo "  3. Create a ThingPark X IoT Flow MQTT connector:"
    echo "     Hostname: $DOMAIN_INPUT  Port: 8883  Protocol: SSL"
    echo "     Upload the three certificate files"
    echo "  4. Assign the connector to your devices in ThingPark"
fi
echo "=========================================="
