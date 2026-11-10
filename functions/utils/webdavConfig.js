import { getUploadConfig } from '../api/manage/sysConfig/upload.js';
import { getDatabase } from './databaseAdapter.js';
import { normalizeWebDAVHeaders } from './storage/webdavAPI.js';
import { findConfiguredChannel } from './metadata/channelConfig.js';
import { getWebDAVAccountId } from './metadata/webdavIdentity.js';

export async function resolveWebDAVConfig(env, metadata = {}) {
    const metadataBaseUrl = metadata.WebDAVBaseUrl;

    try {
        const db = getDatabase(env);
        const uploadConfig = await getUploadConfig(db, env);
        const channels = uploadConfig.webdav?.channels || [];

        const channel = await findConfiguredChannel({ webdav: { channels } }, 'webdav', metadata);

        if (channel) {
            return normalizeWebDAVConfig(channel);
        }
    } catch (error) {
        console.error('Failed to resolve WebDAV channel config:', error);
    }

    const fallback = normalizeWebDAVConfig({
        baseUrl: metadataBaseUrl,
        username: metadata.WebDAVUsername || '',
        password: metadata.WebDAVPassword || '',
        headers: metadata.WebDAVHeaders || {},
        createDirectory: metadata.WebDAVCreateDirectory !== false,
        publicUrl: metadata.WebDAVPublicBaseUrl || '',
    });
    // A credential-free record bound to a private account must not silently
    // fall back to anonymous access when its channel is missing or replaced.
    if (fallback && metadata.WebDAVAccountId &&
        await getWebDAVAccountId(fallback) !== metadata.WebDAVAccountId) return null;
    return fallback;
}

function normalizeWebDAVConfig(config = {}) {
    const baseUrl = getWebDAVBaseUrl(config);
    if (!baseUrl) return null;

    return {
        baseUrl,
        username: config.username || '',
        password: config.password || '',
        headers: normalizeWebDAVHeaders(config.headers || config.customHeaders || {}),
        createDirectory: config.createDirectory !== false,
        publicUrl: config.publicUrl || '',
    };
}

function getWebDAVBaseUrl(config = {}) {
    return config.baseUrl || config.endpoint || config.url || '';
}
