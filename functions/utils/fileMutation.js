// Non-blocking per-file claims. Never expire a claim while its owner may
// still issue a provider DELETE. An interrupted owner needs reconciliation.
const prefix = 'manage@file-mutation/';
const localClaimsByNamespace = new WeakMap();
const localFallback = new Set();
let warnedLocalOnly = false;

export class FileMutationConflict extends Error {
    constructor(message = 'File is busy or already exists') {
        super(message);
        this.status = 409;
    }
}

export function deletionMayStillApply(error) {
    const status = error?.$metadata?.httpStatusCode ?? error?.status;
    // A clear 4xx rejection is retryable after fixing its cause. A timeout,
    // server error, async acceptance or uncertain SDK retry is not a fence.
    return !(status >= 400 && status < 500 && status !== 408 && (error?.$metadata?.attempts ?? 1) === 1);
}

const reserveTable = 'CREATE TABLE IF NOT EXISTS file_mutation_claims (id TEXT PRIMARY KEY, owner TEXT NOT NULL)';
const absent = new Headers({ 'If-None-Match': '*' });

async function keyHash(id) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function coordinator(env) {
    if (env.img_d1?.prepare) {
        const sql = env.img_d1;
        return {
            async prepare() { await sql.prepare(reserveTable).run(); },
            async acquire(id, owner) {
                const row = await sql.prepare('INSERT INTO file_mutation_claims (id, owner) VALUES (?, ?) ON CONFLICT(id) DO NOTHING RETURNING id')
                    .bind(id, owner).first();
                if (!row) throw new FileMutationConflict();
                return () => sql.prepare('DELETE FROM file_mutation_claims WHERE id = ? AND owner = ?').bind(id, owner).run();
            },
        };
    }
    const r2 = env.img_r2;
    if (typeof r2?.head === 'function') {
        return {
            async acquire(id, owner) {
                const key = prefix + 'lock/' + await keyHash(id);
                const result = await r2.put(key, owner, { onlyIf: absent });
                if (result === null) throw new FileMutationConflict();
                return () => r2.delete(key);
            },
        };
    }
    // Compatibility for existing KV-only installs. KV has no atomic create;
    // this branch coordinates one isolate only, not cross-edge requests.
    if (!warnedLocalOnly) {
        warnedLocalOnly = true;
        console.warn('File mutation claims are local only; bind D1 or R2 for cross-instance protection.');
    }
    const namespace = env.img_url;
    let localClaims = localFallback;
    if (namespace && typeof namespace === 'object') {
        localClaims = localClaimsByNamespace.get(namespace) || new Set();
        localClaimsByNamespace.set(namespace, localClaims);
    }
    return {
        async acquire(id) {
            if (localClaims.has(id)) throw new FileMutationConflict();
            localClaims.add(id);
            return () => localClaims.delete(id);
        },
    };
}

// KV can serve old records even after a different isolate released a claim.
// Where an R2 binding exists, keep an opaque generation fence for app writes.
// A stale/missing read is refused, not used to delete/overwrite an object.
async function fencedKV(env, ids) {
    const kv = env.img_url, r2 = env.img_r2;
    if (!kv?.getWithMetadata) return env;
    let readFence, writeFence;
    if (typeof r2?.head === 'function') {
        readFence = async key => (await r2.get(key))?.text();
        writeFence = (key, value) => r2.put(key, value);
    } else if (env.img_d1?.prepare) {
        const sql = env.img_d1;
        await sql.prepare('CREATE TABLE IF NOT EXISTS file_mutation_generations (id TEXT PRIMARY KEY, generation TEXT NOT NULL)').run();
        readFence = async key => (await sql.prepare('SELECT generation FROM file_mutation_generations WHERE id = ?').bind(key).first())?.generation;
        writeFence = (key, value) => sql.prepare('INSERT OR REPLACE INTO file_mutation_generations (id, generation) VALUES (?, ?)').bind(key, value).run();
    } else return env;
    const entries = new Map(await Promise.all(ids.map(async id => {
        const key = prefix + 'generation/' + await keyHash(id);
        const [generation, row] = await Promise.all([readFence(key), kv.getWithMetadata(id)]);
        const current = row?.value != null ? row : null;
        if (generation != null || current?.metadata?.FileMutationGeneration) {
            if (generation !== (current ? current.metadata?.FileMutationGeneration : 'absent')) {
                throw new FileMutationConflict('File metadata has not synchronized; retry later');
            }
        }
        return [id, { key, row: current }];
    })));
    const wrapped = new Proxy(kv, {
        get(target, property) {
            if (property === 'get') return (id, ...args) => entries.has(id) ? Promise.resolve(entries.get(id).row?.value ?? null) : target.get(id, ...args);
            if (property === 'getWithMetadata') return (id, ...args) => entries.has(id)
                ? Promise.resolve(structuredClone(entries.get(id).row ?? { value: null, metadata: null }))
                : target.getWithMetadata(id, ...args);
            if (property === 'put') return async (id, value, options = {}) => {
                const entry = entries.get(id);
                if (!entry || !options.metadata) return target.put(id, value, options);
                const generation = entry.generation ||= crypto.randomUUID();
                const metadata = { ...options.metadata, FileMutationGeneration: generation };
                // If a write is ambiguous, the next writer refuses until the
                // generation is visible; never silently release it as empty.
                await writeFence(entry.key, generation);
                const result = await target.put(id, value, { ...options, metadata });
                entry.row = { value, metadata };
                return result;
            };
            if (property === 'delete') return async (id, ...args) => {
                const entry = entries.get(id);
                if (!entry) return target.delete(id, ...args);
                await writeFence(entry.key, 'absent');
                const result = await target.delete(id, ...args);
                entry.row = null;
                return result;
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return { ...env, img_url: wrapped };
}

export async function withFileMutation(env, fileIds, action) {
    const ids = [...new Set(fileIds)].sort();
    if (ids.some(id => typeof id !== 'string' || !id || id.startsWith('manage@') || id.startsWith('chunk_'))) {
        throw new FileMutationConflict('Invalid file ID');
    }
    const lock = coordinator(env);
    const owner = crypto.randomUUID();
    const releases = [];
    const retained = new Set();
    try {
        await lock.prepare?.();
        for (const id of ids) releases.push([id, await lock.acquire(id, owner)]);
        return await action(await fencedKV(env, ids), id => retained.add(id));
    } finally {
        for (const [id, release] of releases.reverse()) {
            if (retained.has(id)) continue;
            try { await release(); }
            catch (error) { console.error('File mutation claim release failed:', error); }
        }
    }
}
