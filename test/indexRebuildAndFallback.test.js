import assert from 'node:assert/strict';
import { it } from 'node:test';
import '../deploy/server/register.mjs';
import { databaseFixture } from './helpers/databaseFixture.js';
import { mergeOperationsToIndex } from '../functions/utils/indexManager.js';
import { onRequestPost as finalize } from '../functions/api/manage/batch/index/finalize.js';
import { onRequest as list } from '../functions/api/manage/list.js';

const origin = 'https://img.test';
const metadata = { TimeStamp: 1, FileName: 'photo.png', Channel: 'TelegramNew' };
const context = env => ({ env, request: new Request(`${origin}/api/manage/list`), waitUntil() {} });
const post = (env, body) => finalize({ env, request: new Request(`${origin}/api/manage/batch/index/finalize`, {
    method: 'POST', body: JSON.stringify(body),
}) });

it('KV drains a later operation whose random suffix sorts before the previous ID', async t => {
    const { env, db, seed } = databaseFixture(t, 'KV');
    seed('first.png', '', metadata);
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 5000 }));
    await db.putIndexOperation('2000_z', { type: 'add', timestamp: 2000, data: { fileId: 'first.png', metadata } });
    assert.equal((await mergeOperationsToIndex(context(env))).processedOperations, 1);
    seed('second.png', '', metadata);
    await db.putIndexOperation('2000_a', { type: 'add', timestamp: 2000, data: { fileId: 'second.png', metadata } });
    assert.equal((await mergeOperationsToIndex(context(env))).processedOperations, 1);
    assert.deepEqual(JSON.parse(await db.get('manage@index_0')).map(x => x.id).sort(), ['first.png', 'second.png']);
    assert.equal(JSON.parse(await db.get('manage@index@meta')).lastOperationId, null);
});

it('KV add/remove events survive stale file reads until the edge cache catches up', async t => {
    const { env, db, seed } = databaseFixture(t, 'KV');
    const current = { ...metadata, Channel: 'S3', FileName: 'new.png' };
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 5000 }));
    seed('same.png', '', current);
    await db.putIndexOperation('2000_z', { type: 'add', timestamp: 2000, data: { fileId: 'same.png', metadata: current } });
    const getWithMetadata = env.img_url.getWithMetadata.bind(env.img_url);
    env.img_url.getWithMetadata = async key => key === 'same.png' ? null : getWithMetadata(key);
    assert.equal((await mergeOperationsToIndex(context(env))).success, true);
    assert.equal(JSON.parse(await db.get('manage@index_0'))[0].metadata.FileName, 'new.png');
    assert.equal(await db.get('manage@index@operation_2000_z'), null);
    await db.delete('same.png');
    await db.putIndexOperation('2001_a', { type: 'remove', timestamp: 2001, data: { fileId: 'same.png' } });
    env.img_url.getWithMetadata = async key => key === 'same.png'
        ? { value: '', metadata: current } : getWithMetadata(key);
    assert.equal((await mergeOperationsToIndex(context(env))).success, true);
    assert.equal(JSON.parse(await db.get('manage@index@meta')).totalCount, 0);
    assert.equal(await db.get('manage@index@operation_2001_a'), null);
    env.img_url.getWithMetadata = getWithMetadata;
    assert.deepEqual((await list({ ...context(env), request: new Request(`${origin}/api/manage/list`) }).then(r => r.json())).files, []);
});

it('KV pending-operation list errors do not report a successful empty merge', async t => {
    const { env, db } = databaseFixture(t, 'KV');
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 5000 }));
    env.img_url.list = async () => { throw new Error('KV unavailable'); };
    assert.equal((await mergeOperationsToIndex(context(env))).success, false);
});

it('D1 manual rebuild cannot republish a deleted file from stale browser staging', async t => {
    const { env, db, seed } = databaseFixture(t, 'D1');
    seed('deleted.png', '', metadata);
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 1, chunkCount: 1, chunkSize: 500 }));
    await db.put('manage@index_0', JSON.stringify([{ id: 'deleted.png', metadata }]));
    await db.put('chunk_rebuild_stale_0', JSON.stringify({ chunkId: '0', data: [{ id: 'deleted.png', metadata }] }));
    await db.delete('deleted.png');
    await db.putIndexOperation('2000_z', { type: 'remove', timestamp: 2000, data: { fileId: 'deleted.png' } });
    assert.equal((await mergeOperationsToIndex(context(env))).success, true);
    assert.equal((await db.listPendingIndexOperations(10)).length, 0);
    const response = await post(env, { sessionId: 'rebuild_stale', totalChunks: 1, totalFiles: 1 });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).indexedCount, 0);
    assert.equal(await db.get('manage@index_0'), null);
    assert.equal(await db.get('chunk_rebuild_stale_0'), null);
});

it('KV manual rebuild rejects a stale staged file set and leaves the old index intact', async t => {
    const { env, db, seed } = databaseFixture(t, 'KV');
    seed('deleted.png', '', metadata);
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 1, chunkCount: 1, chunkSize: 5000 }));
    await db.put('manage@index_0', JSON.stringify([{ id: 'deleted.png', metadata }]));
    await db.put('chunk_rebuild_kv_0', JSON.stringify({ chunkId: '0', data: [{ id: 'deleted.png', metadata }] }));
    await db.delete('deleted.png');
    seed('current.png', '', metadata);
    const response = await post(env, { sessionId: 'rebuild_kv', totalChunks: 1, totalFiles: 1 });
    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(JSON.parse(await db.get('manage@index_0')).map(x => x.id), ['deleted.png']);
    assert.ok(await db.get('chunk_rebuild_kv_0'));
});

it('KV manual rebuild succeeds when staged and current records agree', async t => {
    const { env, db, seed } = databaseFixture(t, 'KV');
    seed('current.png', '', metadata);
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 5000 }));
    await db.put('chunk_rebuild_current_0', JSON.stringify({ data: [{ id: 'current.png', metadata }] }));
    const response = await post(env, { sessionId: 'rebuild_current', totalChunks: 1, totalFiles: 1 });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(JSON.parse(await db.get('manage@index_0')).map(x => x.id), ['current.png']);
});

it('KV manual rebuild rejects a stale list entry after the file was deleted', async t => {
    const { env, db, seed } = databaseFixture(t, 'KV');
    seed('deleted.png', '', metadata);
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 5000 }));
    await db.put('chunk_rebuild_stale_kv_0', JSON.stringify({ data: [{ id: 'deleted.png', metadata }] }));
    await db.delete('deleted.png');
    const originalList = env.img_url.list.bind(env.img_url);
    env.img_url.list = async options => {
        const result = await originalList(options);
        if (!options.prefix) result.keys.push({ name: 'deleted.png', metadata });
        return result;
    };
    const response = await post(env, { sessionId: 'rebuild_stale_kv', totalChunks: 1, totalFiles: 1 });
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(JSON.parse(await db.get('manage@index@meta')).totalCount, 0);
    assert.ok(await db.get('chunk_rebuild_stale_kv_0'));
});

it('KV manual rebuild rejects a list that omits a staged live upload', async t => {
    const { env, db, seed } = databaseFixture(t, 'KV');
    seed('new.png', '', metadata);
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 5000 }));
    await db.put('chunk_rebuild_missing_0', JSON.stringify({ data: [{ id: 'new.png', metadata }] }));
    const originalList = env.img_url.list.bind(env.img_url);
    env.img_url.list = async options => {
        const result = await originalList(options);
        if (!options.prefix) result.keys = result.keys.filter(key => key.name !== 'new.png');
        return result;
    };
    const response = await post(env, { sessionId: 'rebuild_missing', totalChunks: 1, totalFiles: 1 });
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(JSON.parse(await db.get('manage@index@meta')).totalCount, 0);
});

it('D1 Free finalizes 48 staged chunks without per-chunk queries or orphan rows', async t => {
    const { env, db, seed } = databaseFixture(t, 'D1');
    for (let i = 0; i < 24000; i++) seed(`photo-${String(i).padStart(5, '0')}.png`, '', metadata);
    for (let i = 0; i < 48; i++) seed(`chunk_rebuild_large_${i}`, '{}', {});
    let used = 0;
    const original = env.img_d1.prepare.bind(env.img_d1);
    env.img_d1.prepare = sql => {
        const statement = original(sql);
        for (const method of ['first', 'all', 'run']) {
            const call = statement[method].bind(statement);
            statement[method] = async (...args) => {
                if (++used > 50) throw new Error('D1 Free query limit');
                return call(...args);
            };
        }
        return statement;
    };
    const response = await post(env, { sessionId: 'rebuild_large', totalChunks: 48, totalFiles: 24000 });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).indexedCount, 24000);
    assert.ok(used <= 50, `used ${used} D1 queries`);
    assert.deepEqual((await db.listRebuildChunkIds('rebuild_large')), []);
});

it('D1 rebuild CAS conflict leaves staged chunks intact for a retry', async t => {
    const { env, db, seed } = databaseFixture(t, 'D1');
    seed('live.png', '', metadata);
    const sessionId = 'r'.repeat(90);
    seed(`chunk_${sessionId}_0`, '{}', {});
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 500 }));
    const originalBatch = env.img_d1.batch.bind(env.img_d1);
    env.img_d1.batch = async statements => {
        env.img_d1.batch = originalBatch;
        await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 2, totalCount: 0, chunkCount: 0, chunkSize: 500 }));
        return originalBatch(statements);
    };
    const response = await post(env, { sessionId, totalChunks: 1, totalFiles: 1 });
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(await db.get(`chunk_${sessionId}_0`), '{}');
    assert.equal(JSON.parse(await db.get('manage@index@meta')).lastUpdated, 2);
});

it('database fallback honors search, pagination, and count-only during a large restore', async t => {
    const { env, db, seed } = databaseFixture(t, 'D1');
    await db.put('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 500 }));
    for (let i = 0; i < 605; i++) seed(`photo-${String(i).padStart(3, '0')}.png`, '', {
        ...metadata, TimeStamp: i + 1,
    });
    for (let i = 0; i < 121; i++) await db.putIndexOperation(`op-${String(i).padStart(3, '0')}`, {
        type: 'batch_add', timestamp: i, data: { files: Array.from({ length: 5 }, (_, n) => ({
            fileId: `photo-${String(i * 5 + n).padStart(3, '0')}.png`,
            metadata: { ...metadata, TimeStamp: i * 5 + n + 1 },
        })) },
    });
    const get = async query => {
        const response = await list({ env, request: new Request(`${origin}/api/manage/list?${query}`), waitUntil() {} });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const first = await get('count=1&search=photo');
    assert.equal(first.isIndexedResponse, false);
    assert.deepEqual(first.files.map(file => file.name), ['photo-604.png']);
    const noMatch = await get('count=1&search=does-not-exist');
    assert.equal(noMatch.totalCount, 0);
    assert.deepEqual(noMatch.files, []);
    const page = await get('count=1&start=2');
    assert.equal(page.files.length, 1);
    assert.equal(page.returnedCount, 1);
    assert.equal(page.files[0].name, 'photo-602.png');
    const total = await get('count=-1&sum=true&search=does-not-exist');
    assert.equal(total.sum, 0);
});
