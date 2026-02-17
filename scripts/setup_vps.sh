#!/bin/bash

# VPS Setup Script for MQTT Manager
# Usage: 
# 1. Copy this script to your VPS or run it via curl/wget.
# 2. chmod +x setup_vps.sh
# 3. ./setup_vps.sh

set -e

echo "=========================================="
echo "   MQTT Manager - VPS Setup Script"
echo "=========================================="

# 1. Update System & Install Dependencies
echo "[1/5] Updating system and installing dependencies..."
sudo apt-get update
sudo apt-get install -y git curl ufw

# 2. Install Docker (if not found)
if ! command -v docker &> /dev/null; then
    echo "[2/5] Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    rm get-docker.sh
    echo "Docker installed successfully."
else
    echo "[2/5] Docker is already installed."
fi

# 3. Clone Repository
REPO_URL="https://github.com/MachineSaver/mqtt-manager.git"
DIR_NAME="mqtt-manager"

if [ -d "$DIR_NAME" ]; then
    echo "[3/5] Directory '$DIR_NAME' exists. Pulling latest changes..."
    cd $DIR_NAME
    git pull
else
    echo "[3/5] Cloning repository..."
    git clone $REPO_URL
    cd $DIR_NAME
fi

# 4. Configure Environment
echo "[4/5] Configuring Environment..."
if [ ! -f .env ]; then
    echo "No .env file found. Creating one now."
    
    read -p "Enter your Domain (e.g., mqtt.example.com or IP address): " DOMAIN_INPUT
    
    # Create .env file
    cat <<EOF > .env
DOMAIN=$DOMAIN_INPUT
NEXT_PUBLIC_API_URL=https://$DOMAIN_INPUT
# MQTT Credentials (Optional - leave empty for anonymous)
MQTT_USER=
MQTT_PASS=
EOF
    echo ".env file created."
else
    echo ".env file already exists. Skipping configuration."
    DOMAIN_INPUT=$(grep ^DOMAIN= .env | cut -d '=' -f2)
fi

# 5. Firewall & Startup
echo "[5/5] Configuring Firewall and Starting Services..."

# Allow necessary ports
# 22: SSH
# 80/443: Web (Caddy handles HTTPS)
# 1883: MQTT
# 8883: MQTT SSL
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 1883/tcp
sudo ufw allow 8883/tcp
sudo ufw --force enable

echo "Starting Docker containers..."
sudo docker compose up -d --build

echo "=========================================="
echo "   Setup Complete!"
echo "=========================================="
echo "Web Dashboard: https://$DOMAIN_INPUT"
echo "MQTT Broker:   $DOMAIN_INPUT:1883"
echo "=========================================="
