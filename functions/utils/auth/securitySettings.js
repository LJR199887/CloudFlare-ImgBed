const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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
