import { getDatabase } from '../databaseAdapter.js';
import { findConfiguredChannel, loadChannelConfig } from './channelConfig.js';

// Credentials belong to channel configuration, not file metadata. Legacy metadata
// remains a server-side fallback until its owner explicitly migrates old records.
export async function hydrateFileCredentials(env, metadata = {}) {
    if (!metadata || typeof metadata !== 'object') return metadata;
    const group = {
        S3: 's3', Telegram: 'telegram', TelegramNew: 'telegram',
        Discord: 'discord', HuggingFace: 'huggingface', WebDAV: 'webdav',
    }[metadata.Channel];
    if (!group) return { ...metadata };

    const db = getDatabase(env);
    const config = await loadChannelConfig(db, env, 'file credentials');
    const channel = await findConfiguredChannel(config, group, metadata);
    // A file (including an imported one) is not an authority for where to
    // send a bot token. Orphaned legacy tokens may still use the official API.
    if (!channel) return group === 'telegram'
        ? { ...metadata, TgProxyUrl: '' }
        : { ...metadata };

    const result = { ...metadata };
    if (group === 's3') Object.assign(result, {
        S3Endpoint: metadata.S3Endpoint || channel.endpoint,
        S3Region: metadata.S3Region || channel.region || 'auto',
        S3BucketName: metadata.S3BucketName || channel.bucketName,
        S3PathStyle: metadata.S3PathStyle ?? channel.pathStyle ?? false,
        // An access key ID and secret are one credential, never mix versions.
        S3AccessKeyId: channel.accessKeyId && channel.secretAccessKey ? channel.accessKeyId : metadata.S3AccessKeyId,
        S3SecretAccessKey: channel.accessKeyId && channel.secretAccessKey ? channel.secretAccessKey : metadata.S3SecretAccessKey,
    });
    if (group === 'telegram') Object.assign(result, {
        TgBotToken: channel.botToken || metadata.TgBotToken,
        TgChatId: metadata.TgChatId || channel.chatId,
        TgProxyUrl: channel.proxyUrl || '',
    });
    if (group === 'discord') Object.assign(result, {
        DiscordBotToken: channel.botToken || metadata.DiscordBotToken,
        DiscordChannelId: metadata.DiscordChannelId || channel.channelId,
        DiscordProxyUrl: channel.proxyUrl || '',
    });
    if (group === 'huggingface') Object.assign(result, {
        HfToken: channel.token || metadata.HfToken,
        HfRepo: metadata.HfRepo || channel.repo,
        HfIsPrivate: metadata.HfIsPrivate ?? channel.isPrivate ?? false,
    });
    if (group === 'webdav') Object.assign(result, {
        WebDAVBaseUrl: metadata.WebDAVBaseUrl || channel.baseUrl || channel.endpoint || channel.url,
        WebDAVUsername: channel.username || metadata.WebDAVUsername || '',
        WebDAVPassword: channel.password || metadata.WebDAVPassword || '',
        WebDAVHeaders: channel.headers || channel.customHeaders || metadata.WebDAVHeaders || {},
    });
    return result;
}
