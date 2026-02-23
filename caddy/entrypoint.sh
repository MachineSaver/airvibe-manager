#!/bin/sh
# Generates /etc/caddy/Caddyfile at container start from env vars, then
# execs Caddy. No static Caddyfile is ever committed or mounted.
#
# TLS mode:
#   NETWORK_SERVER=chirpstack OR DOMAIN=localhost → tls internal (LAN self-signed)
#   NETWORK_SERVER=thingpark  AND DOMAIN≠localhost → automatic ACME / Let's Encrypt
set -e

DOMAIN="${DOMAIN:-localhost}"
NETWORK_SERVER="${NETWORK_SERVER:-chirpstack}"

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

echo "caddy entrypoint: generated Caddyfile for domain=${DOMAIN} network_server=${NETWORK_SERVER}"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile "$@"
