# MQTT Manager

A portable, Docker-based MQTT Broker and Management Dashboard. Designed to be easily deployed and provide a "MQTTX-like" experience for monitoring and certificate management.

## Features

- **Mosquitto Broker**: Long-running MQTT broker (Ports 1883, 8883).
- **Web Dashboard**: Next.js application for monitoring messages and managing certificates.
- **Certificate Management**: Generate CA, Server, and Client certificates for secure MQTT connections (Actility ThingPark compatible).
- **Real-time Monitoring**: View MQTT messages in real-time via the web interface.

## Prerequisites

- Docker & Docker Compose
- Git

## Quick Start (Single Command Setup)

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/MachineSaver/mqtt-manager.git
    cd mqtt-manager
    ```

2.  **Configure Environment**:
    Copy the example environment file and edit it if necessary (defaults are usually fine for local dev).
    ```bash
    cp .env.example .env
    ```
    *Edit `.env` to set your `DOMAIN` if deploying to a public server.*

3.  **Start the Stack**:
    ```bash
    docker compose up -d --build
    ```

4.  **Access the Dashboard**:
    Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

### Certificate Management
1.  Go to the **Certificate Management** tab in the sidebar (Key icon).
2.  Enter a **Client ID** (e.g., `device-001`).
3.  Click **Generate & Sign**.
4.  The system will generate:
    - `ca.crt` (if not already present)
    - `server.crt` / `server.key` (if not already present)
    - `[client-id].crt` / `[client-id].key`
5.  **Enable SSL**:
    - After generating the first set of certificates, open `mosquitto/config/mosquitto.conf`.
    - Uncomment the SSL listener section (lines 8-12).
    - Restart the broker: `docker compose restart mqtt-broker`.
6.  These files are stored in the `./certs` directory on your host machine. You can use them to configure your IoT devices or Actility ThingPark.

### MQTT Monitoring
1.  Go to the **MQTT Monitor** tab (Network icon).
2.  The dashboard subscribes to `#` (all topics) and displays messages in real-time.

## Deployment (VPS/Linode)

To deploy this project on a fresh Ubuntu VPS (e.g., Linode, DigitalOcean):

1.  **SSH into your VPS**:
    ```bash
    ssh root@your-vps-ip
    ```

2.  **Download and Run the Setup Script**:
    You can copy the `scripts/setup_vps.sh` file content to your VPS, or run the following commands (assuming you have pushed this repo to GitHub):

    ```bash
    # Install git if missing
    apt-get update && apt-get install -y git

    # Clone the repo
    git clone https://github.com/MachineSaver/mqtt-manager.git
    cd mqtt-manager

    # Run the setup script
    chmod +x scripts/setup_vps.sh
    ./scripts/setup_vps.sh
    ```

3.  **Follow the Prompts**:
    - The script will install Docker, configure the firewall, and ask for your **Domain/IP**.
    - It will generate the `.env` file and start the services.

4.  **Access the App**:
    - Open `http://<your-vps-ip>:3000` in your browser.

## Project Structure

- `docker-compose.yml`: Defines the services (Broker, Backend, Frontend).
- `mosquitto/`: Mosquitto configuration and data.
- `backend/`: Node.js Express API & MQTT Client.
- `frontend/`: Next.js Web Application.
- `certs/`: Shared volume for generated certificates.

## CI/CD

This project uses GitHub Actions to verify the Docker build on every push to `main`.
