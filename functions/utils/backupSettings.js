// Only portable configuration belongs in a settings backup. Runtime state
// (sessions, upload grants, indexes, and cleanup status) must be rebuilt.
export const BACKUP_SETTING_KEYS = Object.freeze([
    'manage@sysConfig@security',
    'manage@sysConfig@upload',
    'manage@sysConfig@page',
    'manage@sysConfig@others',
    'manage@sysConfig@cleanup',
    'manage@blockipList',
]);

export function isBackupSettingKey(key) {
    return BACKUP_SETTING_KEYS.includes(key);
}
