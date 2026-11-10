// Browser-facing storage bytes are untrusted, including their declared MIME.
// Only known passive formats may render inline. In particular, attachment
// alone does not stop a JavaScript upload being loaded as a subresource.
const INLINE = new Set((
    'image/jpeg image/jpg image/png image/gif image/webp image/avif image/bmp image/tiff image/x-icon image/vnd.microsoft.icon image/heic image/heif ' +
    'audio/mpeg audio/mp4 audio/aac audio/ogg audio/opus audio/wav audio/x-wav audio/flac audio/webm video/mp4 video/webm video/ogg video/quicktime video/x-msvideo video/x-matroska ' +
    'text/plain application/pdf'
).split(' '));

export function applyDownloadPolicy(headers, fileType, encodedName = 'download') {
    const type = String(fileType || '').split(';', 1)[0].trim().toLowerCase();
    // Never echo the untrusted parameter tail. Commas in it can make the
    // browser select a second MIME type (including JavaScript).
    const inline = INLINE.has(type) && !/[\r\n,]/.test(String(fileType));
    const charset = /;\s*charset\s*=\s*(?:"([a-zA-Z0-9_-]+)"|([a-zA-Z0-9_-]+))\s*(?:;|$)/i.exec(String(fileType));
    const safeType = type + (charset ? `; charset=${charset[1] || charset[2]}` : '');
    headers.set('Content-Type', inline ? safeType : 'application/octet-stream');
    headers.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
}

// Never copy Cookie, Authorization, Host, Referer or custom application headers.
export function pickHeaders(source, names) {
    const result = new Headers();
    for (const name of names) if (source.has(name)) result.set(name, source.get(name));
    return result;
}

export const DOWNLOAD_REQUEST_HEADERS = ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since'];
export const DOWNLOAD_RESPONSE_HEADERS = ['Content-Type', 'Content-Length', 'Content-Range', 'Last-Modified', 'ETag', 'Content-Encoding'];

export function httpFileUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch { return null; }
}

// Every redirect is a new destination, never an implicit credentialed fetch.
// Docker injects a DNS-pinned public-only transport; Workers use platform
// fetch. Deployments may additionally restrict imports to exact trusted origins.
export async function fetchImportedFile(initial, env) {
    const allowed = env.FETCH_RES_ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean);
    let url = initial;
    for (let redirects = 0; redirects <= 5; redirects++) {
        if (allowed?.length && !allowed.includes(url.origin)) throw new Error('Unapproved origin');
        const response = typeof env.fetchPublicHop === 'function' ? await env.fetchPublicHop(url)
            : await fetch(url.href, { redirect: 'manual' });
        if (![301,302,303,307,308].includes(response.status)) return response;
        const location = response.headers.get('Location');
        await response.body?.cancel();
        url = location && httpFileUrl(new URL(location,url).href);
        if (!url) throw new Error('Invalid download redirect');
    }
    throw new Error('Too many download redirects');
}

// /file can return a redirect for an External upload. Do not let an ordinary
// same-origin fetch silently follow a user-supplied target into Docker's LAN.
export async function fetchFileForDisplay(fileUrl, env) {
    const response = await fetch(fileUrl, { redirect: 'manual' });
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get('Location');
    await response.body?.cancel();
    const target = location && httpFileUrl(new URL(location,fileUrl).href);
    if (!target) throw new Error('Invalid external file redirect');
    return fetchImportedFile(target, env);
}

// Retain a remote download's suggested filename without replaying arbitrary
// Content-Disposition parameters or remote response headers on our origin.
export function remoteFileName(response, url) {
    const disposition = response.headers.get('Content-Disposition') || '';
    const star = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(disposition);
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition);
    let name = plain?.[1] || plain?.[2]?.trim();
    try { if (star) name = decodeURIComponent(star[1]); } catch { /* use ordinary filename */ }
    if (!name) {
        name = url.pathname.split('/').pop();
        try { name = decodeURIComponent(name); } catch { /* keep literal name */ }
    }
    name = (name || 'download').split(/[\\/]/).pop() || 'download';
    return encodeURIComponent(name);
}
