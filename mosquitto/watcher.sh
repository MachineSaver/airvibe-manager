#!/bin/sh
CERT_FILE="/mosquitto/certs/server.crt"
CA_FILE="/mosquitto/certs/ca.crt"
KEY_FILE="/mosquitto/certs/server.key"
CONF_DIR="/mosquitto/config"
BASE_CONF="$CONF_DIR/mosquitto.conf"
NOSSL_CONF="$CONF_DIR/mosquitto_nossl.conf"

# Create a no-SSL fallback config (plain MQTT only)
create_nossl_conf() {
    cat > "$NOSSL_CONF" <<'EOF'
persistence true
persistence_location /mosquitto/data/
log_dest stdout

listener 1883
allow_anonymous true
EOF
}

# Check if all TLS cert files exist
certs_exist() {
    [ -f "$CERT_FILE" ] && [ -f "$CA_FILE" ] && [ -f "$KEY_FILE" ]
}

# Pick the right config
get_conf() {
    if certs_exist; then
        echo "$BASE_CONF"
    else
        echo "$NOSSL_CONF"
    fi
}

# Function to get file timestamp
get_file_state() {
    stat -c %Y "$CERT_FILE" 2>/dev/null || echo 0
}

echo "Starting Mosquitto Watchdog..."
echo "Watching $CERT_FILE"

# Create fallback config
create_nossl_conf

CONF=$(get_conf)
echo "Using config: $CONF"

# Start Mosquitto in background
/usr/sbin/mosquitto -c "$CONF" &
MOSQUITTO_PID=$!

LAST_STATE=$(get_file_state)

# Monitor loop
while true; do
    sleep 5
    CURRENT_STATE=$(get_file_state)

    if [ "$CURRENT_STATE" != "$LAST_STATE" ]; then
        CONF=$(get_conf)
        echo "Certificate changed ($LAST_STATE -> $CURRENT_STATE). Restarting Mosquitto with $CONF..."
        kill -TERM "$MOSQUITTO_PID"
        wait "$MOSQUITTO_PID"

        /usr/sbin/mosquitto -c "$CONF" &
        MOSQUITTO_PID=$!
        LAST_STATE=$CURRENT_STATE
    fi

    # Check if Mosquitto is still running
    if ! kill -0 "$MOSQUITTO_PID" 2>/dev/null; then
        echo "Mosquitto exited unexpectedly. Restarting..."
        sleep 2
        CONF=$(get_conf)
        /usr/sbin/mosquitto -c "$CONF" &
        MOSQUITTO_PID=$!
    fi
done
