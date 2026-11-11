const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const SECURITY_SETTINGS_KEY = 'manage@sysConfig@security';

export function validateSecuritySettings(settings) {
    if (!isRecord(settings) || (settings.auth !== undefined && !isRecord(settings.auth))) {
        throw new Error('Invalid security configuration');
    }
    for (const [section, fields] of [['admin', ['adminUsername', 'adminPassword']], ['user', ['authCode']]]) {
        const value = settings.auth?.[section];
        if (value === undefined) continue;
        if (!isRecord(value) || fields.some(key => value[key] != null && typeof value[key] !== 'string')) {
            throw new Error('Invalid authentication configuration');
        }
    }
    return settings;
}

export function parseSecuritySettings(raw) {
    let settings;
    try { settings = JSON.parse(raw); }
    catch { throw new Error('Invalid security configuration JSON'); }
    return validateSecuritySettings(settings);
}

export function rotateSessionEpochs(settings, types = ['admin', 'user']) {
    const epochs = { ...settings.sessionEpochs };
    for (const type of types) epochs[type] = crypto.randomUUID();
    settings.sessionEpochs = epochs;
    return settings;
}

// Read/modify/write callers must not resurrect pre-restore credentials and
// session versions. D1 has an atomic comparison; on KV this is best-effort.
export async function writeSecuritySettingsIfCurrent(db, previous, settings) {
    const value = JSON.stringify(settings);
    if (typeof db.db?.prepare === 'function') {
        const result = previous == null
            ? await db.db.prepare('INSERT OR IGNORE INTO settings (key, value, category) VALUES (?, ?, ?)')
                .bind(SECURITY_SETTINGS_KEY, value, 'security').run()
            : await db.db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ? AND value = ?')
                .bind(value, SECURITY_SETTINGS_KEY, previous).run();
        return result.meta?.changes > 0;
    }
    if ((await db.get(SECURITY_SETTINGS_KEY)) !== previous) return false;
    await db.put(SECURITY_SETTINGS_KEY, value);
    return true;
}
