import { isSafeFileId } from './fileId.js';

// A D1 Worker may only issue 50 queries on Free. Moving a single file can
// acquire two claims, validate credentials and consume multiple writes. Each
// page gets a fresh request budget, including enough to queue its index update.
const pageSize = 2;
export function needsPagedFolderMutation(env) {
    return typeof env.img_d1?.prepare === 'function' && env.img_d1.isLocalSQLite !== true;
}

async function listPage(env, prefix, cursor) {
    if (typeof env.img_url?.get === 'function') {
        const page = await env.img_url.list({ prefix, limit: pageSize, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.keys) || page.keys.length > pageSize || (!page.list_complete && !page.cursor)) {
            throw new Error('Invalid KV folder page');
        }
        return { items: page.keys.map(({name, metadata}) => ({ id: name, metadata })), next: page.list_complete ? null : page.cursor || null };
    }
    if (cursor && (!isSafeFileId(cursor) || !cursor.startsWith(prefix))) throw new Error('Invalid folder cursor');
    // The upper bound is the same path with the final slash incremented from
    // U+002F to U+0030. Under the files primary key's binary collation this
    // selects only descendants, without LIKE wildcard/length limitations.
    const upper = `${prefix.slice(0, -1)}0`;
    const response = await env.img_d1.prepare('SELECT id, metadata FROM files WHERE id > ? AND id < ? ORDER BY id LIMIT ?')
        .bind(cursor || prefix, upper, pageSize + 1).all();
    const rows = response.results || [];
    const items = rows.slice(0, pageSize).map(row => {
        let metadata = null;
        try { metadata = JSON.parse(row.metadata || '{}'); } catch { /* Report the corrupt record and continue. */ }
        return { id: row.id, metadata };
    });
    return { items, next: rows.length > pageSize ? items.at(-1).id : null };
}

export async function runPagedFolderMutation(context, { folder, resultKey, mutate, queueIndex, warnings, headers }) {
    const url = new URL(context.request.url);
    if (url.searchParams.get('paged') !== '1') {
        return Response.json({ success: false, error: 'Folder operations on D1 require pagination; refresh the management page' }, { status: 413, headers });
    }
    if (!isSafeFileId(folder)) return Response.json({ success: false, error: 'Invalid folder' }, { status: 400, headers });
    const prefix = `${folder}/`;
    const cursor = url.searchParams.get('cursor');
    const { items, next } = await listPage(context.env, prefix, cursor);
    if (next && next === cursor) throw new Error('Folder cursor did not advance');
    const processed = [], failed = [];
    for (const {id, metadata} of items) {
        if (!isSafeFileId(id) || !id.startsWith(prefix) || !metadata) { failed.push(id); continue; }
        // Refuse to act on a different record that reused the same name after
        // enumeration. The check runs only after acquiring the file claim.
        const expected = JSON.stringify(metadata);
        const result = await mutate(id, current => JSON.stringify(current.metadata) === expected);
        if (result) processed.push(result);
        else failed.push(id);
    }
    const result = { success: true, [resultKey]: processed, failed, nextCursor: next, ...(warnings ? {warnings} : {}) };
    if (processed.length) {
        const index = await queueIndex(processed);
        if (index?.success === false) {
            return Response.json({ ...result, success: false, error: 'Files changed but the index update could not be queued' }, { status: 503, headers });
        }
    }
    return Response.json(result, { headers });
}
