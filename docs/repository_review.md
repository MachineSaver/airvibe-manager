# Repository Review: MQTT Manager

## High-level Architecture
- Docker Compose orchestrates four services: a Mosquitto broker (Eclipse Mosquitto 2), a Node.js backend, a Next.js frontend, and a Caddy reverse proxy/SSL terminator. Service wiring relies on an internal Docker network with shared `./certs` volume for TLS assets and exposes ports 80/443 for Caddy plus 1883/8883 for MQTT. [Sources: `docker-compose.yml`, `mosquitto/config/mosquitto.conf`, `mosquitto/watcher.sh`]
- Backend bootstraps MQTT connectivity and PKI assets on startup, emitting events to the frontend via Socket.IO. It also provides REST endpoints for certificate generation. [Source: `backend/src/index.js`]
- Frontend is a Next.js client that consumes Socket.IO events, offers MQTT monitoring, and includes a rich command/preset builder UI for publishing downlinks. [Source: `frontend/src/app/page.tsx`]

## Dependency Surface
### Orchestration and host prerequisites
- Requires Docker and Docker Compose; setup script installs git, curl, ufw, and Docker when missing and opens firewall ports 22/80/443/1883/8883. [Source: `scripts/setup_vps.sh`]
- Caddy handles HTTPS with automatic certificates; depends on `DOMAIN` env var for host routing. [Source: `Caddyfile` (implicit via compose environment)]

### Service images and base layers
- Mosquitto uses `eclipse-mosquitto:2`; custom entrypoint (`watcher.sh`) restarts broker when TLS cert changes. [Source: `docker-compose.yml`, `mosquitto/watcher.sh`]
- Backend image builds from `node:20-alpine`, installs `openssl`, and runs `npm start`. TLS material is generated at runtime into `/app/certs`. [Source: `backend/Dockerfile`, `backend/src/pki.js`]
- Frontend image builds from `node:20-alpine` and runs `npm run dev` (development server) instead of a production build. [Source: `frontend/Dockerfile`]

### Application dependencies
- Backend runtime dependencies: Express 4, MQTT 5 client, CORS, dotenv, and Socket.IO 4; uses nodemon for development. [Source: `backend/package.json`]
- Frontend runtime dependencies: Next 16, React/ReactDOM 19, `socket.io-client` 4.8, and `react18-json-view`; dev dependencies include Tailwind CSS 4, TypeScript 5, and ESLint 9. [Source: `frontend/package.json`]
- PKI uses OpenSSL via child processes to generate CA/server/client certificates and stores them on the shared volume. [Source: `backend/src/pki.js`]

## Complexity Assessment
- Code footprint is small: backend has three source files (HTTP server, MQTT client wrapper, PKI helper) and limited routing logic; frontend is a single-page client with Socket.IO plumbing plus a sizable command-preset table but minimal state management abstractions. [Sources: `backend/src`, `frontend/src/app/page.tsx`]
- Docker stack is straightforward with few services and minimal custom logic beyond the Mosquitto watcher script; suitable for VPS deployment with modest resources.

## Notable Observations & Risks
- Frontend container runs `npm run dev`; consider building (`next build`) and serving (`next start`) for production to reduce overhead and enable Next.js optimizations.
- Mosquitto is configured with `allow_anonymous true`; tighten authentication if exposed publicly, possibly leveraging the `.env` MQTT credentials mentioned in the README/setup script.
- Certificate generation assumes persistent shared volume and OpenSSL availability; ensure permissions on `/app/certs` and host-mounted `./certs` are writable on the VPS.
- Socket.IO CORS is wide open (`origin: "*"`); restrict to expected domains once DNS is configured to reduce attack surface.
