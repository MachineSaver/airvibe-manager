'use strict';

/**
 * ThingPark adapter — identity passthrough in both directions.
 *
 * Uplinks: ThingPark publishes directly to the canonical internal topic
 *   mqtt/things/{devEUI}/uplink with a DevEUI_uplink JSON envelope.
 *   No translation required.
 *
 * Downlinks: the backend publishes to mqtt/things/{devEUI}/downlink with
 *   a DevEUI_downlink JSON envelope. ThingPark expects exactly that format
 *   on the same topic. No translation required.
 */

function normalizeIncoming(topic, message) {
    return { topic, message };
}

function normalizeOutgoing(topic, message) {
    return { topic, message };
}

module.exports = { normalizeIncoming, normalizeOutgoing };
