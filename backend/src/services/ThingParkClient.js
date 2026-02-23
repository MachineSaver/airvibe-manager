/**
 * ThingParkClient.js
 *
 * Optional backend service for managing Class A ↔ Class C device profile
 * switching around FUOTA sessions via the ThingPark DX Core API.
 *
 * Gracefully no-ops when THINGPARK_CLIENT_ID / THINGPARK_CLIENT_SECRET
 * are not set — the FUOTA session will still proceed, just without the
 * automatic Class C profile switch.
 *
 * Environment variables:
 *   THINGPARK_BASE_URL        — base URL  (default: https://community.thingpark.io)
 *   THINGPARK_CLIENT_ID       — OAuth2 client ID
 *   THINGPARK_CLIENT_SECRET   — OAuth2 client secret
 *   THINGPARK_CLASS_C_PROFILE — device profile ID to switch to for FUOTA
 *                               (default EU868: LORA/GenericC.1.0.4a_ETSI)
 *                               (default US915: LORA/GenericC.1.0.4a_FCC)
 */

class ThingParkClient {
    constructor() {
        this.baseUrl = (process.env.THINGPARK_BASE_URL || 'https://community.thingpark.io').replace(/\/$/, '');
        this.clientId = process.env.THINGPARK_CLIENT_ID || '';
        this.clientSecret = process.env.THINGPARK_CLIENT_SECRET || '';
        this.classCProfile = process.env.THINGPARK_CLASS_C_PROFILE || 'LORA/GenericC.1.0.4a_ETSI';

        this.configured = !!(this.clientId && this.clientSecret);

        // Cached OAuth2 token
        this._token = null;
        this._tokenExpiresAt = 0;

        if (this.configured) {
            console.log('ThingParkClient: configured — Class C auto-switch enabled');
        } else {
            console.log('ThingParkClient: THINGPARK_CLIENT_ID/SECRET not set — Class C auto-switch disabled');
        }
    }

    // -----------------------------------------------------------------------
    // OAuth2 token lifecycle
    // -----------------------------------------------------------------------

    async _getToken() {
        if (!this.configured) return null;

        const now = Date.now();
        if (this._token && now < this._tokenExpiresAt - 30000) {
            return this._token;
        }

        const tokenUrl = `${this.baseUrl}/users-auth/protocol/openid-connect/token`;
        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.clientId,
            client_secret: this.clientSecret,
        });

        const res = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ThingPark OAuth2 failed (${res.status}): ${text}`);
        }

        const json = await res.json();
        this._token = json.access_token;
        this._tokenExpiresAt = now + (json.expires_in || 3600) * 1000;
        return this._token;
    }

    /** Invalidate cached token (called on 401 responses). */
    _invalidateToken() {
        this._token = null;
        this._tokenExpiresAt = 0;
    }

    /**
     * Perform an authenticated fetch. On 401, invalidates token and retries once.
     */
    async _fetch(url, options = {}) {
        const token = await this._getToken();
        if (!token) return null;

        const doFetch = async (t) => fetch(url, {
            ...options,
            headers: {
                'Authorization': `Bearer ${t}`,
                'Content-Type': 'application/json',
                ...(options.headers || {}),
            },
        });

        let res = await doFetch(token);

        if (res.status === 401) {
            this._invalidateToken();
            const freshToken = await this._getToken();
            if (!freshToken) return null;
            res = await doFetch(freshToken);
        }

        return res;
    }

    // -----------------------------------------------------------------------
    // Device resolution
    // -----------------------------------------------------------------------

    /**
     * Resolve ThingPark internal device ref (integer) from DevEUI.
     * Returns the ref number or null on failure.
     */
    async getDeviceRef(devEui) {
        if (!this.configured) return null;
        try {
            const url = `${this.baseUrl}/thingpark/wireless/rest/subscriptions/mine/devices/${devEui}`;
            const res = await this._fetch(url);
            if (!res || !res.ok) {
                const text = res ? await res.text().catch(() => '') : '';
                console.warn(`ThingParkClient: getDeviceRef failed for ${devEui} (${res?.status}): ${text}`);
                return null;
            }
            const json = await res.json();
            // ThingPark returns { ref: <integer>, ... }
            return json.ref ?? json.id ?? null;
        } catch (err) {
            console.warn(`ThingParkClient: getDeviceRef error for ${devEui}:`, err.message);
            return null;
        }
    }

    /**
     * Get the current deviceProfileId for a device.
     * @param {number|string} deviceRef  ThingPark internal device ref
     */
    async getCurrentProfile(deviceRef) {
        if (!this.configured) return null;
        try {
            const url = `${this.baseUrl}/thingpark/dx/core/latest/api/devices/${deviceRef}`;
            const res = await this._fetch(url);
            if (!res || !res.ok) {
                const text = res ? await res.text().catch(() => '') : '';
                console.warn(`ThingParkClient: getCurrentProfile failed for ref ${deviceRef} (${res?.status}): ${text}`);
                return null;
            }
            const json = await res.json();
            return json.deviceProfileId ?? null;
        } catch (err) {
            console.warn(`ThingParkClient: getCurrentProfile error for ref ${deviceRef}:`, err.message);
            return null;
        }
    }

    /**
     * Set the deviceProfileId for a device.
     * @param {number|string} deviceRef  ThingPark internal device ref
     * @param {string} profileId         Target device profile ID
     */
    async setProfile(deviceRef, profileId) {
        if (!this.configured) return false;
        try {
            const url = `${this.baseUrl}/thingpark/dx/core/latest/api/devices/${deviceRef}`;
            const res = await this._fetch(url, {
                method: 'PUT',
                body: JSON.stringify({ deviceProfileId: profileId }),
            });
            if (!res || !res.ok) {
                const text = res ? await res.text().catch(() => '') : '';
                console.warn(`ThingParkClient: setProfile failed for ref ${deviceRef} → ${profileId} (${res?.status}): ${text}`);
                return false;
            }
            return true;
        } catch (err) {
            console.warn(`ThingParkClient: setProfile error for ref ${deviceRef}:`, err.message);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Composite operations
    // -----------------------------------------------------------------------

    /**
     * Switch device to Class C profile before starting FUOTA.
     * Returns { deviceRef, originalProfileId } on success, null on failure/unconfigured.
     */
    async switchToClassC(devEui) {
        if (!this.configured) return null;
        try {
            const deviceRef = await this.getDeviceRef(devEui);
            if (deviceRef == null) {
                console.warn(`ThingParkClient: switchToClassC — could not resolve ref for ${devEui}`);
                return null;
            }

            const originalProfileId = await this.getCurrentProfile(deviceRef);
            if (!originalProfileId) {
                console.warn(`ThingParkClient: switchToClassC — could not get current profile for ref ${deviceRef}`);
                return null;
            }

            const ok = await this.setProfile(deviceRef, this.classCProfile);
            if (!ok) return null;

            console.log(`ThingParkClient: ${devEui} (ref ${deviceRef}) switched to Class C (${this.classCProfile}), was ${originalProfileId}`);
            return { deviceRef, originalProfileId };
        } catch (err) {
            console.warn(`ThingParkClient: switchToClassC error for ${devEui}:`, err.message);
            return null;
        }
    }

    /**
     * Restore device to its original profile after FUOTA completes/fails/aborts.
     * @param {string} devEui
     * @param {string} originalProfileId  Saved before the Class C switch
     * @param {number|string} deviceRef   Saved before the Class C switch
     */
    async restoreClass(devEui, originalProfileId, deviceRef) {
        if (!this.configured) return false;
        try {
            const ok = await this.setProfile(deviceRef, originalProfileId);
            if (ok) {
                console.log(`ThingParkClient: ${devEui} (ref ${deviceRef}) restored to ${originalProfileId}`);
            }
            return ok;
        } catch (err) {
            console.warn(`ThingParkClient: restoreClass error for ${devEui}:`, err.message);
            return false;
        }
    }
}

module.exports = new ThingParkClient();
