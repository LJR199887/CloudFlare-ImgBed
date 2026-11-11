import { normalizeWebDAVHeaders } from '../storage/webdavAPI.js';
import { stripSensitiveMetadata } from './metadataSecurity.js';

// Same WebDAV URL can expose different files for different accounts. Persist a
// hashed binding, not the username/password, to survive display renames.
// Basic passwords may rotate; custom auth headers are conservatively bound to
// their exact values because their account identity cannot otherwise be inferred.
export async function getWebDAVAccountId(config = {}) {
    const headers = [...new Headers(normalizeWebDAVHeaders(config.headers || config.customHeaders || {})).entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    let embeddedUsername = '';
    let embeddedPassword = '';
    try {
        const url = new URL(config.baseUrl || config.endpoint || config.url);
        embeddedUsername = decodeURIComponent(url.username);
        embeddedPassword = decodeURIComponent(url.password);
    } catch { /* no URL userinfo */ }
    const username = String(config.username || embeddedUsername);
    // With an empty username, the password can itself be an account/API token.
    const identity = JSON.stringify([username, username ? '' : String(config.password || embeddedPassword), headers]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function getMetadataWebDAVAccountId(metadata = {}) {
    if (metadata.WebDAVAccountId) return metadata.WebDAVAccountId;
    let hasUserinfo = false;
    try { const url = new URL(metadata.WebDAVBaseUrl); hasUserinfo = Boolean(url.username || url.password); } catch { /* no URL */ }
    if (!hasUserinfo && !['WebDAVUsername', 'WebDAVPassword', 'WebDAVHeaders'].some(key => Object.hasOwn(metadata, key))) return null;
    return getWebDAVAccountId({ baseUrl: metadata.WebDAVBaseUrl, username: metadata.WebDAVUsername, password: metadata.WebDAVPassword, headers: metadata.WebDAVHeaders });
}

export function hasWebDAVPassword(config = {}) {
    if (config.password) return true;
    try { return Boolean(new URL(config.baseUrl || config.endpoint || config.url).password); }
    catch { return false; }
}

// Old redacted records have no password-presence bit. A bare basic username
// cannot prove a formerly password-protected file is usable. Fail closed for
// those records, but allow explicitly passwordless, anonymous and header auth.
export function satisfiesWebDAVAuth(channel, metadata) {
    if (hasWebDAVPassword(channel)) return true;
    if (metadata.WebDAVRequiresPassword === true || metadata.WebDAVPassword ||
        hasWebDAVPassword({ baseUrl: metadata.WebDAVBaseUrl })) return false;
    if (metadata.WebDAVRequiresPassword === false || !metadata.WebDAVAccountId) return true;
    let username = channel.username;
    try { username ||= new URL(channel.baseUrl || channel.endpoint || channel.url).username; } catch { /* no URL */ }
    return !username || new Headers(normalizeWebDAVHeaders(channel.headers || channel.customHeaders)).has('Authorization');
}

export async function prepareMetadataForStorage(metadata = {}) {
    const copy = { ...metadata };
    if (copy.Channel === 'WebDAV') {
        if (hasWebDAVPassword({ baseUrl: copy.WebDAVBaseUrl, password: copy.WebDAVPassword })) {
            copy.WebDAVRequiresPassword = true;
        } else if (copy.WebDAVRequiresPassword == null && !copy.WebDAVAccountId &&
                   Object.hasOwn(copy, 'WebDAVPassword')) {
            copy.WebDAVRequiresPassword = false;
        }
    }
    if (copy.Channel === 'WebDAV' && !copy.WebDAVAccountId) {
        const accountId = await getMetadataWebDAVAccountId(copy);
        if (accountId) copy.WebDAVAccountId = accountId;
    }
    return stripSensitiveMetadata(copy);
}
