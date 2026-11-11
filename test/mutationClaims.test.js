import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { onRequest as manage } from '../functions/api/manage/_middleware.js';
import { onRequest as saveSecurity } from '../functions/api/manage/sysConfig/security.js';
import { onRequestPost as restore } from '../functions/api/manage/batch/restore/chunk.js';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { deletionMayStillApply, withFileMutation } from '../functions/utils/fileMutation.js';
import { WebDAVAPI } from '../functions/utils/storage/webdavAPI.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../functions/utils/metadata/writeSafety.js';
import { databaseFixture } from './helpers/databaseFixture.js';
import { loadFunction } from './helpers/loadFunction.js';

const origin = 'https://img.test';
const metadata = { Channel: 'CloudflareR2', FileType: 'image/png' };
const mocks = {
    getDatabase: createDatabaseAdapter, hydrateFileCredentials, assertLegacyWriteSafe,
    purgeCFCache: async () => {}, purgeRandomFileListCache: async () => {}, purgePublicFileListCache: async () => {},
    moveFileInIndex: async () => {}, sanitizeUploadFolder: x => x,
};
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
function fixture(t, backend, hooks = {}) {
    const { env, db, seed } = databaseFixture(t, backend === 'D1' ? 'D1' : 'KV');
    if (backend === 'KV+D1') env.img_d1 = databaseFixture(t, 'D1').env.img_d1;
    const objects = new Map();
    env.img_r2 = {
        async get(id) { return objects.has(id) ? { body: objects.get(id), text: async () => objects.get(id) } : null; },
        async put(id, value, options) {
            await hooks.put?.(id, value);
            if (options?.onlyIf?.get('If-None-Match') === '*' && objects.has(id)) return null;
            objects.set(id, value);
            return {};
        },
        async delete(id) { await hooks.delete?.(id); objects.delete(id); },
        ...(backend === 'KV+R2' ? { async head(id) { return objects.has(id) ? {} : null; } } : {}),
    };
    const add = (id, value) => { seed(id, '', { ...metadata, FileName: id }); objects.set(id, value); };
    return { env, db, add, objects };
}
async function handlers() {
    const { onRequest } = await loadFunction('functions/api/manage/rename/[[path]].js', mocks);
    const { deleteFile } = await loadFunction('functions/api/manage/delete/[[path]].js', mocks);
    return {
        rename(env, id, target) {
            return onRequest({ env, params: { path: id }, waitUntil() {}, request: new Request(`${origin}/api/manage/rename/${id}`, {
                method: 'POST', body: JSON.stringify({ newFileId: target }),
            }) });
        },
        remove: (env, id, predicate) => deleteFile(env, id, `${origin}/file/${id}`, new URL(origin), predicate),
    };
}

describe('file mutation claims', () => {
    for (const backend of ['KV', 'D1', 'KV+R2', 'KV+D1']) {
        it(`${backend}: concurrent renames cannot overwrite a destination or delete the losing source`, async t => {
            const entered = deferred(), finish = deferred();
            const { env, db, add, objects } = fixture(t, backend, { put: async (id, bytes) => {
                if (id === 'same.png' && bytes === 'A') { entered.resolve(); await finish.promise; }
            } });
            add('a.png', 'A'); add('b.png', 'B');
            const { rename } = await handlers();
            const pending = rename(env, 'a.png', 'same.png');
            await entered.promise;
            try {
                assert.equal((await rename({ ...env }, 'b.png', 'same.png')).status, 409);
                assert.equal(objects.get('b.png'), 'B');
                assert.ok((await db.getWithMetadata('b.png'))?.metadata);
            } finally { finish.resolve(); }
            assert.equal((await pending).status, 200);
            assert.equal(objects.get('same.png'), 'A');
            assert.equal(objects.get('b.png'), 'B');
            assert.equal(objects.has('a.png'), false);
        });

        it(`${backend}: a second deletion cannot release a name during the first cleanup`, async t => {
            const entered = deferred(), finish = deferred();
            const { env, db, add, objects } = fixture(t, backend, { delete: async id => {
                if (id === 'old.png') { entered.resolve(); await finish.promise; }
            } });
            add('old.png', 'old');
            const { rename, remove } = await handlers();
            const pending = rename(env, 'old.png', 'new.png');
            await entered.promise;
            try {
                assert.equal(await remove({ ...env }, 'old.png'), false);
                assert.equal(await db.get('old.png'), '');
                await assert.rejects(withFileMutation({ ...env }, ['old.png'], async () => assert.fail('name was released')), { status: 409 });
            } finally { finish.resolve(); }
            assert.equal((await pending).status, 200);
            await withFileMutation(env, ['old.png'], async scoped => {
                assert.equal(await createDatabaseAdapter(scoped).get('old.png'), null);
                await scoped.img_r2.put('old.png', 'new upload');
                await createDatabaseAdapter(scoped).put('old.png', '', { metadata });
            });
            assert.equal(objects.get('old.png'), 'new upload');
            assert.equal(objects.get('new.png'), 'old');
        });
    }

    it('R2: unknown provider delete outcome keeps the old name claimed but not the destination', async t => {
        const { env, db, add, objects } = fixture(t, 'KV+R2', { delete: async id => {
            if (id === 'old.png') throw new Error('lost DELETE acknowledgement');
        } });
        add('old.png', 'old');
        const { rename, remove } = await handlers();
        const response = await rename(env, 'old.png', 'new.png');
        assert.equal(response.status, 200);
        assert.equal((await response.json()).warnings.length, 1);
        assert.equal(objects.get('new.png'), 'old');
        assert.ok((await db.getWithMetadata('old.png'))?.metadata);
        assert.equal(await remove(env, 'old.png'), false);
        await assert.rejects(withFileMutation(env, ['old.png'], async () => {}), { status: 409 });
        await withFileMutation(env, ['new.png'], async scoped => assert.equal(await createDatabaseAdapter(scoped).get('new.png'), ''));
    });

    for (const backend of ['KV+R2', 'KV+D1']) {
        it(`${backend}: stale KV hit and stale miss do not authorize destructive writes`, async t => {
            const { env, db, add, objects } = fixture(t, backend);
            add('old.png', 'old');
            const { rename, remove } = await handlers();
            assert.equal((await rename(env, 'old.png', 'new.png')).status, 200);
            // Simulate another edge returning the pre-delete record for old.png,
            // and a cached miss for the now occupied new.png.
            await env.img_url.put('old.png', '', { metadata });
            await env.img_url.delete('new.png');
            add('another.png', 'another');
            assert.equal(await remove(env, 'old.png'), false);
            assert.equal((await rename(env, 'another.png', 'new.png')).status, 409);
            assert.equal(objects.get('new.png'), 'old');
            assert.equal(objects.get('another.png'), 'another');
            assert.equal(await db.get('another.png'), '');
        });
    }

    it('an existing R2 object without a row cannot be overwritten by rename', async t => {
        const { env, add, objects } = fixture(t, 'KV+R2');
        add('source.png', 'source'); objects.set('orphan.png', 'keep');
        const { rename } = await handlers();
        assert.equal((await rename(env, 'source.png', 'orphan.png')).status, 409);
        assert.equal(objects.get('source.png'), 'source');
        assert.equal(objects.get('orphan.png'), 'keep');
    });

    it('D1 cleanup cannot delete a different file than it selected', async t => {
        const { env, add, objects } = fixture(t, 'D1');
        add('reused.png', 'new');
        const { remove } = await handlers();
        assert.equal(await remove(env, 'reused.png', row => row.metadata.TimeStamp === 1), false);
        assert.equal(objects.get('reused.png'), 'new');
    });

    for (const status of [202, 207, 403]) {
        it(`WebDAV ${status} does not confirm deletion`, async t => {
            t.mock.method(globalThis, 'fetch', async () => new Response('', { status }));
            const api = new WebDAVAPI({ baseUrl: 'https://dav.test' });
            await assert.rejects(api.deleteFile('old.png'), error => {
                assert.equal(error.status, status);
                assert.equal(deletionMayStillApply(error), status !== 403);
                return true;
            });
        });
    }
});

describe('security config writers reject values the reader cannot load', () => {
    for (const backend of ['KV', 'D1']) {
        it(`${backend}: update and restore preserve the previous working credentials`, async t => {
            const { env, db } = databaseFixture(t, backend);
            env.BASIC_USER = 'admin'; env.BASIC_PASS = 'fixture-only';
            const settingsKey = 'manage@sysConfig@security';
            const original = JSON.stringify({ apiTokens: { tokens: { x: { token: 'fixture-token', permissions: ['manage'] } } } });
            await db.put(settingsKey, original);
            const post = (path, body, handler) => {
                const request = new Request(origin + path, { method: 'POST', headers: { Authorization: 'Bearer fixture-token' }, body: JSON.stringify(body) });
                return manage[0]({ next: () => manage[1]({ env, request, next: () => handler({ env, request }) }) });
            };
            for (const invalid of [{ auth: { admin: { adminPassword: false } } }, { auth: { user: { authCode: [] } } }, [], null]) {
                assert.equal((await post('/api/manage/sysConfig/security', invalid, saveSecurity)).status, 400);
                const response = await post('/api/manage/batch/restore/chunk', { type: 'settings', data: { 'sysConfig@security': invalid } }, restore);
                const result = await response.json();
                assert.equal(result.restoredCount, 0);
                assert.equal(result.failedCount, 1);
                assert.equal(await db.get(settingsKey), original);
            }
            const corrupt = await post('/api/manage/batch/restore/chunk', { type: 'settings', data: { [settingsKey]: '{' } }, restore);
            assert.equal((await corrupt.json()).failedCount, 1);
            const accepted = await post('/api/manage/batch/restore/chunk', { type: 'settings', data: { [settingsKey]: original } }, restore);
            assert.equal((await accepted.json()).restoredCount, 1);
        });
    }
});
