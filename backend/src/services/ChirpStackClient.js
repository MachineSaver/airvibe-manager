/**
 * ChirpStackClient.js
 *
 * Optional backend service for managing Class A ↔ Class C device switching
 * around FUOTA sessions via the ChirpStack REST API (v4).
 *
 * Gracefully no-ops when CHIRPSTACK_API_KEY is not set — the FUOTA session
 * will still proceed, but the device must be manually set to Class C in the
 * ChirpStack UI before each FUOTA and restored afterward.
 *
 * Environment variables:
 *   CHIRPSTACK_API_URL  — base URL of ChirpStack server  (default: http://chirpstack:8080)
 *   CHIRPSTACK_API_KEY  — API key generated in ChirpStack UI (required to enable auto-switch)
 */

class ChirpStackClient {
    constructor() {
        this.baseUrl = (process.env.CHIRPSTACK_API_URL || 'http://chirpstack:8080').replace(/\/$/, '');
        this.apiKey  = process.env.CHIRPSTACK_API_KEY  || '';

        this.configured = !!this.apiKey;

        if (this.configured) {
            console.log('ChirpStackClient: configured — Class C auto-switch enabled');
        } else {
            console.log('ChirpStackClient: CHIRPSTACK_API_KEY not set — Class C auto-switch disabled');
        }
    }

    // -----------------------------------------------------------------------
    // Internal HTTP helper
    // -----------------------------------------------------------------------

    async _request(method, path, body) {
        if (!this.configured) return null;
        const url = `${this.baseUrl}${path}`;
        const opts = {
            method,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type':  'application/json',
            },
        };
        if (body !== undefined) {
            opts.body = JSON.stringify(body);
        }
        try {
            const res = await fetch(url, opts);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                console.warn(`ChirpStackClient: ${method} ${path} failed (${res.status}): ${text}`);
                return null;
            }
            return await res.json();
        } catch (err) {
            console.warn(`ChirpStackClient: ${method} ${path} error:`, err.message);
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Device management
    // -----------------------------------------------------------------------

    /**
     * Fetch the full device object from ChirpStack.
     * Returns the device object or null on failure.
     * @param {string} devEui
     */
    async getDevice(devEui) {
        if (!this.configured) return null;
        const result = await this._request('GET', `/api/devices/${devEui.toLowerCase()}`);
        return result?.device ?? null;
    }

    /**
     * Update a device's classEnabled field.
     * Requires the full device object (GET → mutate → PUT pattern).
     *
     * @param {string} devEui
     * @param {'CLASS_A'|'CLASS_B'|'CLASS_C'} deviceClass
     * @returns {boolean} true on success
     */
    async setDeviceClass(devEui, deviceClass) {
        if (!this.configured) return false;

        const device = await this.getDevice(devEui);
        if (!device) {
            console.warn(`ChirpStackClient: setDeviceClass — could not fetch device ${devEui}`);
            return false;
        }

        const updated = { ...device, classEnabled: deviceClass };
        const result = await this._request('PUT', `/api/devices/${devEui.toLowerCase()}`, { device: updated });
        return result !== null;
    }

    // -----------------------------------------------------------------------
    // Composite operations (same interface as ThingParkClient)
    // -----------------------------------------------------------------------

    /**
     * Switch device to Class C before starting FUOTA.
     * Returns { originalClass } on success, null on failure/unconfigured.
     * @param {string} devEui
     */
    async switchToClassC(devEui) {
        if (!this.configured) return null;
        try {
            const device = await this.getDevice(devEui);
            if (!device) {
                console.warn(`ChirpStackClient: switchToClassC — could not fetch device ${devEui}`);
                return null;
            }

            const originalClass = device.classEnabled || 'CLASS_A';
            if (originalClass === 'CLASS_C') {
                // Already Class C — nothing to do but still return a record so
                // the session knows to "restore" on completion (restore is a no-op here).
                console.log(`ChirpStackClient: ${devEui} is already Class C`);
                return { originalClass };
            }

            const ok = await this.setDeviceClass(devEui, 'CLASS_C');
            if (!ok) return null;

            console.log(`ChirpStackClient: ${devEui} switched to Class C (was ${originalClass})`);
            return { originalClass };
        } catch (err) {
            console.warn(`ChirpStackClient: switchToClassC error for ${devEui}:`, err.message);
            return null;
        }
    }

    /**
     * Restore device to its original class after FUOTA completes/fails/aborts.
     * @param {string} devEui
     * @param {string} originalClass  e.g. 'CLASS_A'
     */
    async restoreClass(devEui, originalClass) {
        if (!this.configured) return false;
        try {
            if (originalClass === 'CLASS_C') {
                // Was already Class C before FUOTA — nothing to restore
                return true;
            }
            const ok = await this.setDeviceClass(devEui, originalClass || 'CLASS_A');
            if (ok) {
                console.log(`ChirpStackClient: ${devEui} restored to ${originalClass || 'CLASS_A'}`);
            }
            return ok;
        } catch (err) {
            console.warn(`ChirpStackClient: restoreClass error for ${devEui}:`, err.message);
            return false;
        }
    }
}

module.exports = new ChirpStackClient();
