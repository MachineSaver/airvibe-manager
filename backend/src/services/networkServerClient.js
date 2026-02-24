/**
 * networkServerClient.js
 *
 * Unified Class C switching interface for FUOTA sessions.
 * Selects ChirpStackClient or ThingParkClient at module load time based on
 * the NETWORK_SERVER environment variable.
 *
 * Exposes a consistent interface regardless of which client is active:
 *   configured          {boolean}  — true when credentials are present
 *   type                {string}   — 'chirpstack' | 'thingpark'
 *   switchToClassC(devEui)         → { originalClass } | null
 *   restoreClass(devEui, originalClass) → boolean
 *
 * The `originalClass` value is opaque to callers (FUOTAManager stores and
 * returns it as-is). For ChirpStack it is a class string ('CLASS_A' etc.);
 * for ThingPark it is the { deviceRef, originalProfileId } object returned
 * by ThingParkClient.switchToClassC — both are handled internally here.
 */

const NETWORK_SERVER = (process.env.NETWORK_SERVER || 'chirpstack').toLowerCase();

if (NETWORK_SERVER === 'thingpark') {
    const tpClient = require('./ThingParkClient');

    module.exports = {
        get configured() { return tpClient.configured; },
        type: 'thingpark',

        async switchToClassC(devEui, classCProfile) {
            const result = await tpClient.switchToClassC(devEui, classCProfile);
            if (!result) return null;
            // Wrap { deviceRef, originalProfileId } into the { originalClass }
            // envelope that FUOTAManager expects, so the restore token is opaque.
            return { originalClass: result };
        },

        async restoreClass(devEui, originalClass) {
            if (!originalClass || typeof originalClass !== 'object') return false;
            return tpClient.restoreClass(devEui, originalClass.originalProfileId, originalClass.deviceRef);
        },
    };
} else {
    const csClient = require('./ChirpStackClient');

    module.exports = {
        get configured() { return csClient.configured; },
        type: 'chirpstack',
        switchToClassC: csClient.switchToClassC.bind(csClient),
        restoreClass:   csClient.restoreClass.bind(csClient),
    };
}
