#!/bin/sh
# Fix ownership of the bind-mounted certs directory so nodeapp can write to it
chown nodeapp:nodeapp /app/certs

exec su-exec nodeapp node src/index.js
