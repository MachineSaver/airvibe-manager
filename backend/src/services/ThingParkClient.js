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
 *   THINGPARK_BASE_URL       — base URL  (default: https://community.thingpark.io)
 *   THINGPARK_CLIENT_ID      — OAuth2 client ID
 *   THINGPARK_CLIENT_SECRET  — OAuth2 client secret
 *
 * The Class C device profile (ETSI vs FCC) is determined per-device from the
 * ISM band detected in uplink Frequency fields (MessageTracker → devices.metadata),
 * with the FUOTA UI providing an explicit band selector as a fallback for devices
 * that have not yet sent any uplinks.  There is no global env-var default — the
 * user must actively select the correct region.
 */

const log = require('../logger').child({ module: 'ThingParkClient' });

class ThingParkClient {
    constructor() {
        this.baseUrl = (process.env.THINGPARK_BASE_URL || 'https://community.thingpark.io').replace(/\/$/, '');
        this.clientId = process.env.THINGPARK_CLIENT_ID || '';
        this.clientSecret = process.env.THINGPARK_CLIENT_SECRET || '';

        this.configured = !!(this.clientId && this.clientSecret);

        // Cached OAuth2 token
        this._token = null;
        this._tokenExpiresAt = 0;

        if (this.configured) {
            log.info('ThingParkClient: configured — Class C auto-switch enabled');
        } else {
            log.info('ThingParkClient: THINGPARK_CLIENT_ID/SECRET not set — Class C auto-switch disabled');
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
            // Use DX Core API device list with DevEUI filter.
            // The Wireless REST API (/subscriptions/mine/devices/...) is subscription-scoped
            // and returns 400 "Device not found" when the OAuth2 application belongs to a
            // different subscription than the device.
            const url = `${this.baseUrl}/thingpark/dx/core/latest/api/devices?deviceEUI=${encodeURIComponent(devEui)}`;
            const res = await this._fetch(url);
            if (!res || !res.ok) {
                const text = res ? await res.text().catch(() => '') : '';
                log.warn(`ThingParkClient: getDeviceRef failed for ${devEui} (${res?.status}): ${text}`);
                return null;
            }
            const json = await res.json();
            // DX Core API returns { list: [ { ref, devEUI, ... } ], totalCount }
            const list = Array.isArray(json.list) ? json.list : (Array.isArray(json) ? json : []);
            if (list.length === 0) {
                log.warn(`ThingParkClient: device ${devEui} not found via DX Core API`);
                return null;
            }
            const device = list[0];
            return device.ref ?? device.id ?? null;
        } catch (err) {
            log.warn(`ThingParkClient: getDeviceRef error for ${devEui}: ${err.message}`);
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
                log.warn(`ThingParkClient: getCurrentProfile failed for ref ${deviceRef} (${res?.status}): ${text}`);
                return null;
            }
            const json = await res.json();
            return json.deviceProfileId ?? null;
        } catch (err) {
            log.warn(`ThingParkClient: getCurrentProfile error for ref ${deviceRef}: ${err.message}`);
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
                log.warn(`ThingParkClient: setProfile failed for ref ${deviceRef} → ${profileId} (${res?.status}): ${text}`);
                return false;
            }
            // Verify the response body reflects the new profile — ThingPark could return
            // 200 OK but silently ignore the change (e.g. bad field name, missing fields).
            const json = await res.json().catch(() => null);
            const applied = json?.deviceProfileId;
            if (applied && applied !== profileId) {
                log.warn(
                    `ThingParkClient: setProfile ref ${deviceRef} returned 200 but ` +
                    `deviceProfileId is '${applied}', not '${profileId}' — treating as failure`
                );
                return false;
            }
            return true;
        } catch (err) {
            log.warn(`ThingParkClient: setProfile error for ref ${deviceRef}: ${err.message}`);
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
    /**
     * Switch device to Class C profile before starting FUOTA.
     * @param {string} devEui
     * @param {string} [classCProfileOverride]  Per-device profile derived from ISM band.
     *   Overrides THINGPARK_CLASS_C_PROFILE env var when provided.  Falls back to env var
     *   when absent (e.g. brand-new device with no uplinks seen yet).
     */
    async switchToClassC(devEui, classCProfileOverride) {
        if (!this.configured) return null;
        if (!classCProfileOverride) {
            log.warn(
                `ThingParkClient: ${devEui} — no Class C profile specified. ` +
                `Select the correct ISM band in the FUOTA Manager before starting the session.`
            );
            return null;
        }
        const targetProfile = classCProfileOverride;
        try {
            const deviceRef = await this.getDeviceRef(devEui);
            if (deviceRef == null) {
                log.warn(`ThingParkClient: switchToClassC — could not resolve ref for ${devEui}`);
                return null;
            }

            const originalProfileId = await this.getCurrentProfile(deviceRef);
            if (!originalProfileId) {
                log.warn(`ThingParkClient: switchToClassC — could not get current profile for ref ${deviceRef}`);
                return null;
            }

            const ok = await this.setProfile(deviceRef, targetProfile);
            if (!ok) return null;

            log.info(`ThingParkClient: ${devEui} (ref ${deviceRef}) switched to Class C (${targetProfile}), was ${originalProfileId}`);
            return { deviceRef, originalProfileId };
        } catch (err) {
            log.warn(`ThingParkClient: switchToClassC error for ${devEui}: ${err.message}`);
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
                log.info(`ThingParkClient: ${devEui} (ref ${deviceRef}) restored to ${originalProfileId}`);
            }
            return ok;
        } catch (err) {
            log.warn(`ThingParkClient: restoreClass error for ${devEui}: ${err.message}`);
            return false;
        }
    }
}

module.exports = new ThingParkClient();
