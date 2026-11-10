import { findConfiguredChannel, loadChannelConfig } from './channelConfig.js';

const GROUPS = { S3: 's3', Telegram: 'telegram', TelegramNew: 'telegram', Discord: 'discord', HuggingFace: 'huggingface', WebDAV: 'webdav' };

// Do not erase the only remaining credentials during an unrelated metadata edit.
// Restore a matching channel first; this also guards payloads without old secrets.
export async function assertLegacyWriteSafe(db, env, fileId) {
    if (fileId.startsWith('manage@') || fileId.startsWith('chunk_')) return;
    const old = await db.getWithMetadata(fileId);
    const metadata = old?.metadata;
    const group = GROUPS[metadata?.Channel];
    if (!group || !hasLegacyCredentials(metadata, group)) return;
    const config = await loadChannelConfig(db, env, 'legacy metadata update');
    const channel = findConfiguredChannel(config, group, metadata);
    if (!channel || !hasReplacementCredentials(channel, group, metadata)) {
        throw new Error('Cannot update legacy file: restore its matching storage channel configuration before removing metadata credentials.');
    }
}

function hasLegacyCredentials(m, group) {
    const keys = { s3: ['S3AccessKeyId', 'S3SecretAccessKey'], telegram: ['TgBotToken'], discord: ['DiscordBotToken'], huggingface: ['HfToken'], webdav: ['WebDAVUsername', 'WebDAVPassword', 'WebDAVHeaders'] }[group];
    if (keys.some(key => Boolean(m[key]) && (typeof m[key] !== 'object' || Object.keys(m[key]).length > 0))) return true;
    try { const url = new URL(m.WebDAVBaseUrl); return group === 'webdav' && Boolean(url.username || url.password); } catch { return false; }
}

function hasReplacementCredentials(c, group, m) {
    if (group === 's3') return Boolean(c.endpoint && c.bucketName && c.accessKeyId && c.secretAccessKey);
    if (group === 'telegram') return Boolean(c.botToken && c.chatId);
    if (group === 'discord') return Boolean(c.botToken && c.channelId);
    if (group === 'huggingface') return Boolean(c.token && c.repo);
    let url;
    try { url = new URL(c.baseUrl || c.endpoint || c.url); } catch { /* invalid config */ }
    let oldUrl;
    try { oldUrl = new URL(m.WebDAVBaseUrl); } catch { /* no URL credentials */ }
    if ((m.WebDAVUsername || oldUrl?.username) && !(c.username || url?.username)) return false;
    if ((m.WebDAVPassword || oldUrl?.password) && !(c.password || url?.password)) return false;
    if (m.WebDAVHeaders && Object.keys(m.WebDAVHeaders).length && !Object.keys(c.headers || c.customHeaders || {}).length) return false;
    return true;
}
