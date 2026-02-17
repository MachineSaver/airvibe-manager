#!/bin/sh
# Fix ownership of the bind-mounted certs directory so nodeapp can write to it
chown nodeapp:nodeapp /app/certs
# Make certs readable by Mosquitto (runs as uid 1883 in its own container)
chmod 755 /app/certs
chmod -f 644 /app/certs/*.crt /app/certs/*.csr /app/certs/*.srl /app/certs/*.ext 2>/dev/null || true
chmod -f 644 /app/certs/*.key 2>/dev/null || true

exec su-exec nodeapp node src/index.js
