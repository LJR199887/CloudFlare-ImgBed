// The random path already travels through the shipped frontend. Use its UUID
// to look up a server-issued grant without changing the browser protocol.
export const HUGGING_FACE_GRANT_PREFIX = 'manage@hf-upload@';
const ttlSeconds = 3600;
const grantTable = 'CREATE TABLE IF NOT EXISTS hf_upload_grants (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL)';

function grantId(path) {
    return typeof path === 'string' ? /(?:^|\/)([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})_[^/]+$/.exec(path)?.[1] : undefined;
}

function store(env) {
    if (env.img_d1?.prepare) {
        const db = env.img_d1;
        return {
            async put(id, payload, expiresAt) {
                await db.prepare(grantTable).run();
                await db.prepare('DELETE FROM hf_upload_grants WHERE expires_at <= ?').bind(Date.now()).run();
                await db.prepare('INSERT INTO hf_upload_grants (id, payload, expires_at) VALUES (?, ?, ?)').bind(id, payload, expiresAt).run();
            },
            async get(id) {
                await db.prepare(grantTable).run();
                return (await db.prepare('SELECT payload FROM hf_upload_grants WHERE id = ? AND expires_at > ?').bind(id, Date.now()).first())?.payload;
            },
            async consume(id) {
                return Boolean(await db.prepare('DELETE FROM hf_upload_grants WHERE id = ? AND expires_at > ? RETURNING id').bind(id, Date.now()).first());
            },
        };
    }
    if (typeof env.img_r2?.head === 'function') {
        const r2 = env.img_r2;
        return {
            put: (id, payload) => r2.put(HUGGING_FACE_GRANT_PREFIX + id, payload),
            async get(id) { return (await r2.get(HUGGING_FACE_GRANT_PREFIX + id))?.text(); },
            async consume(id) { await r2.delete(HUGGING_FACE_GRANT_PREFIX + id); return true; },
        };
    }
    return {
        put: (id, payload) => env.img_url.put(HUGGING_FACE_GRANT_PREFIX + id, payload, { expirationTtl: ttlSeconds }),
        get: id => env.img_url.get(HUGGING_FACE_GRANT_PREFIX + id),
        async consume(id) { await env.img_url.delete(HUGGING_FACE_GRANT_PREFIX + id); return true; },
        eventual: true,
    };
}

export async function issueHuggingFaceGrant(env, grant) {
    const id = grantId(grant.filePath);
    if (!id) throw new Error('Invalid generated HuggingFace path');
    const expiresAt = Date.now() + ttlSeconds * 1000;
    await store(env).put(id, JSON.stringify({ ...grant, expiresAt }), expiresAt);
}

// Caller holds the file claim from validation through commit. The consumed
// grant is not restored after a lost acknowledgement; start a fresh upload.
export async function getHuggingFaceGrant(env, input) {
    const id = grantId(input.filePath);
    if (!id) return null;
    const backend = store(env);
    const raw = await backend.get(id);
    if (!raw) return null;
    const grant = JSON.parse(raw);
    if (!grant || !(grant.expiresAt > Date.now()) || grant.filePath !== input.filePath || grant.fullId !== input.fullId
        || grant.sha256 !== input.sha256 || grant.fileSize !== input.fileSize
        || (input.channelName !== undefined && grant.channelName !== input.channelName)) return null;
    return { grant, consume: () => backend.consume(id), eventual: backend.eventual === true };
}
