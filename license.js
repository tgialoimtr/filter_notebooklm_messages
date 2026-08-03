/**
 * License — Lemon Squeezy License API client + trial/license state.
 *
 * 3-day free trial (timed from true install, see background.js), then a
 * one-time $10 purchase activated via a Lemon Squeezy license key.
 * No backend: the License API's activate/validate/deactivate endpoints
 * are unauthenticated and callable directly from the extension.
 */

(() => {
  'use strict';

  const API_BASE = 'https://api.lemonsqueezy.com/v1/licenses';
  const LICENSE_KEY_STORAGE = 'license_info';
  const INSTANCE_NAME_STORAGE = 'license_instance_name';
  const TRIAL_DAYS = 3;
  const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days offline-safe window

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(items) {
    return new Promise((resolve) => chrome.storage.local.set(items, resolve));
  }

  async function getInstanceName() {
    const result = await storageGet([INSTANCE_NAME_STORAGE]);
    if (result[INSTANCE_NAME_STORAGE]) return result[INSTANCE_NAME_STORAGE];
    const name = crypto.randomUUID();
    await storageSet({ [INSTANCE_NAME_STORAGE]: name });
    return name;
  }

  async function callLicenseApi(endpoint, params) {
    const body = new URLSearchParams(params);
    try {
      const res = await fetch(`${API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const data = await res.json();
      return { ok: res.ok, data };
    } catch (err) {
      console.warn(`License API ${endpoint} failed:`, err.message);
      return { ok: false, data: null, networkError: true };
    }
  }

  async function getLicenseInfo() {
    const result = await storageGet([LICENSE_KEY_STORAGE]);
    return result[LICENSE_KEY_STORAGE] || null;
  }

  async function getInstallDate() {
    const result = await storageGet(['license_install_date']);
    return result.license_install_date || Date.now();
  }

  /**
   * Returns { status: 'trial'|'expired'|'licensed', daysLeft? }.
   * Licensed status is read from local cache first (offline-safe); a stale
   * cache triggers a background revalidate() rather than blocking the UI.
   */
  async function getState() {
    const info = await getLicenseInfo();

    if (info && info.status === 'licensed') {
      const age = Date.now() - (info.lastValidatedAt || 0);
      if (age <= GRACE_PERIOD_MS) {
        return { status: 'licensed' };
      }
      // Stale but optimistically still licensed — revalidate in the background.
      revalidate();
      return { status: 'licensed' };
    }

    const installDate = await getInstallDate();
    const daysElapsed = (Date.now() - installDate) / (24 * 60 * 60 * 1000);
    if (daysElapsed < TRIAL_DAYS) {
      return { status: 'trial', daysLeft: Math.max(0, Math.ceil(TRIAL_DAYS - daysElapsed)) };
    }
    return { status: 'expired' };
  }

  /**
   * Activates a license key against this install (as a Lemon Squeezy
   * "instance"). Returns { success: true } or { success: false, error }.
   */
  async function activate(licenseKey) {
    const key = (licenseKey || '').trim();
    if (!key) return { success: false, error: 'Enter a license key.' };

    const instanceName = await getInstanceName();
    const { ok, data, networkError } = await callLicenseApi('activate', {
      license_key: key,
      instance_name: instanceName,
    });

    if (networkError) return { success: false, error: 'Network error — check your connection and try again.' };
    if (!ok || !data || !data.activated) {
      return { success: false, error: (data && data.error) || 'Activation failed. Check your license key.' };
    }

    await storageSet({
      [LICENSE_KEY_STORAGE]: {
        status: 'licensed',
        licenseKey: key,
        instanceId: data.instance.id,
        lastValidatedAt: Date.now(),
      },
    });
    return { success: true };
  }

  /**
   * Re-checks the stored license against Lemon Squeezy. Only an explicit
   * valid:false downgrades to 'expired' — network/timeout errors are
   * swallowed so a flaky connection never revokes access.
   */
  async function revalidate() {
    const info = await getLicenseInfo();
    if (!info || info.status !== 'licensed') return;

    const { ok, data, networkError } = await callLicenseApi('validate', {
      license_key: info.licenseKey,
      instance_id: info.instanceId,
    });

    if (networkError) return;

    if (ok && data && data.valid) {
      await storageSet({
        [LICENSE_KEY_STORAGE]: { ...info, lastValidatedAt: Date.now() },
      });
    } else if (data && data.valid === false) {
      await storageSet({
        [LICENSE_KEY_STORAGE]: { ...info, status: 'expired' },
      });
    }
  }

  window.License = { getState, activate, revalidate };
})();
