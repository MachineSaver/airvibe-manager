#!/bin/sh
CERT_FILE="/mosquitto/certs/server.crt"

# Function to get file timestamp
get_file_state() {
    stat -c %Y "$CERT_FILE" 2>/dev/null || echo 0
}

echo "Starting Mosquitto Watchdog..."
echo "Watching $CERT_FILE"

# Start Mosquitto in background
/usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf &
MOSQUITTO_PID=$!

LAST_STATE=$(get_file_state)

# Monitor loop
while true; do
    sleep 5
    CURRENT_STATE=$(get_file_state)
    
    if [ "$CURRENT_STATE" != "$LAST_STATE" ]; then
        echo "Certificate changed ($LAST_STATE -> $CURRENT_STATE). Restarting Mosquitto..."
        kill -TERM "$MOSQUITTO_PID"
        wait "$MOSQUITTO_PID"
        
        /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf &
        MOSQUITTO_PID=$!
        LAST_STATE=$CURRENT_STATE
    fi
    
    # Check if Mosquitto is still running
    if ! kill -0 "$MOSQUITTO_PID" 2>/dev/null; then
        echo "Mosquitto exited unexpectedly. Exiting watchdog."
        exit 1
    fi
done
