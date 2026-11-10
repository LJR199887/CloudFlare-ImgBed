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
    const channel = findConfiguredChannel(config, group, metadata);
    if (!channel) return { ...metadata };

    const result = { ...metadata };
    if (group === 's3') Object.assign(result, {
        S3Endpoint: channel.endpoint || metadata.S3Endpoint,
        S3Region: channel.region || metadata.S3Region || 'auto',
        S3BucketName: channel.bucketName || metadata.S3BucketName,
        S3PathStyle: channel.pathStyle ?? metadata.S3PathStyle ?? false,
        S3AccessKeyId: channel.accessKeyId || metadata.S3AccessKeyId,
        S3SecretAccessKey: channel.secretAccessKey || metadata.S3SecretAccessKey,
    });
    if (group === 'telegram') Object.assign(result, {
        TgBotToken: channel.botToken || metadata.TgBotToken,
        TgChatId: channel.chatId || metadata.TgChatId,
        TgProxyUrl: channel.proxyUrl || metadata.TgProxyUrl || '',
    });
    if (group === 'discord') Object.assign(result, {
        DiscordBotToken: channel.botToken || metadata.DiscordBotToken,
        DiscordChannelId: channel.channelId || metadata.DiscordChannelId,
        DiscordProxyUrl: channel.proxyUrl || metadata.DiscordProxyUrl || '',
    });
    if (group === 'huggingface') Object.assign(result, {
        HfToken: channel.token || metadata.HfToken,
        HfRepo: channel.repo || metadata.HfRepo,
        HfIsPrivate: channel.isPrivate ?? metadata.HfIsPrivate ?? false,
    });
    if (group === 'webdav') Object.assign(result, {
        WebDAVBaseUrl: channel.baseUrl || channel.endpoint || channel.url || metadata.WebDAVBaseUrl,
        WebDAVUsername: channel.username || metadata.WebDAVUsername || '',
        WebDAVPassword: channel.password || metadata.WebDAVPassword || '',
        WebDAVHeaders: channel.headers || channel.customHeaders || metadata.WebDAVHeaders || {},
    });
    return result;
}
