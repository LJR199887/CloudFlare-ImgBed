const LEGACY_PREFIX = 'manage@index_';
const SNAPSHOT_PREFIX = 'manage@index_snapshot_';
const SNAPSHOT_RE = /^manage@index_snapshot_(\d{13})_[0-9a-f-]{36}_$/;
const RETAIN_OLD_MS = 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

export function newKVIndexChunkPrefix() {
    return `${SNAPSHOT_PREFIX}${Date.now()}_${crypto.randomUUID()}_`;
}

export function kvIndexChunkKey(metadata, chunkId) {
    if (!Number.isSafeInteger(chunkId) || chunkId < 0) throw new Error('Invalid index chunk ID');
    const prefix = metadata?.chunkPrefix || LEGACY_PREFIX;
    if (prefix !== LEGACY_PREFIX && !SNAPSHOT_RE.test(prefix)) {
        throw new Error('Invalid KV index chunk prefix');
    }
    return `${prefix}${chunkId}`;
}

// Keep old generations long enough for KV's cross-location propagation. This
// is best-effort garbage collection; it never removes the published generation.
export async function pruneKVIndexChunks(db, activePrefix) {
    const now = Date.now();
    if (now - lastPruneAt < 60 * 60 * 1000) return;
    lastPruneAt = now;
    try {
        let cursor;
        do {
            const page = await db.list({ prefix: SNAPSHOT_PREFIX, limit: 1000, cursor });
            const stale = page.keys.filter(({ name }) => {
                const match = name.match(/^(manage@index_snapshot_\d{13}_[0-9a-f-]{36}_)(\d+)$/);
                return match && match[1] !== activePrefix && Number(match[1].slice(SNAPSHOT_PREFIX.length, SNAPSHOT_PREFIX.length + 13)) < now - RETAIN_OLD_MS;
            });
            for (const { name } of stale) await db.delete(name);
            cursor = page.list_complete === false ? page.cursor : null;
        } while (cursor);
    } catch (error) {
        lastPruneAt = 0;
        console.warn('Could not prune old KV index chunks:', error);
    }
}
