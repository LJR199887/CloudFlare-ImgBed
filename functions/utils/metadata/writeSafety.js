import { findConfiguredChannel, loadChannelConfig } from './channelConfig.js';
import { prepareMetadataForStorage } from './webdavIdentity.js';

const GROUPS = { S3: 's3', Telegram: 'telegram', TelegramNew: 'telegram', Discord: 'discord', HuggingFace: 'huggingface', WebDAV: 'webdav' };

// Do not erase the only remaining credentials during an edit or backup restore.
// Check both sides: imports may target an empty database, while updates may omit
// secrets that are still present in the existing record.
export async function assertLegacyWriteSafe(db, env, fileId, incomingMetadata) {
    if (fileId.startsWith('manage@') || fileId.startsWith('chunk_')) return;
    const old = await db.getWithMetadata(fileId);
    const candidates = [old?.metadata, incomingMetadata].filter(metadata => {
        const group = GROUPS[metadata?.Channel];
        return group && hasLegacyCredentials(metadata, group);
    });
    if (!candidates.length) return;
    const config = await loadChannelConfig(db, env, 'legacy metadata update');
    for (const metadata of candidates) {
        const group = GROUPS[metadata.Channel];
        const channel = await findConfiguredChannel(config, group, metadata);
        // A secret can disambiguate otherwise identical channels. Make sure the
        // persisted, credential-free record can still resolve a complete channel.
        const persisted = await prepareMetadataForStorage(metadata);
        const persistedChannel = await findConfiguredChannel(config, group, persisted);
        if (!channel || !hasReplacementCredentials(channel, group, metadata) ||
            !persistedChannel || !hasReplacementCredentials(persistedChannel, group, metadata)) {
            throw new Error('Cannot write legacy file: restore its matching storage channel configuration before removing metadata credentials, then retry the file operation.');
        }
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
