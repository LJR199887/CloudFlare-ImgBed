import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { databaseFixture } from './helpers/databaseFixture.js';
import { loadFunction } from './helpers/loadFunction.js';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { stripSensitiveMetadata, stripUrlUserinfo } from '../functions/utils/metadata/metadataSecurity.js';
import { TelegramAPI } from '../functions/utils/storage/telegramAPI.js';
import { WebDAVAPI } from '../functions/utils/storage/webdavAPI.js';
import * as fileTools from '../functions/file/fileTools.js';
import { onRequestGet as list } from '../functions/api/manage/batch/list.js';
import { onRequestPost as restore } from '../functions/api/manage/batch/restore/chunk.js';

const fileRoute = () => loadFunction('functions/file/[[path]].js', {
    ...fileTools, getDatabase: createDatabaseAdapter, fetchSecurityConfig: async () => ({ access: {} }),
    hydrateFileCredentials, TelegramAPI, stripUrlUserinfo,
});

describe('Telegram request destination and bot selection', () => {
    for (const chunked of [false, true]) {
        for (const mode of ['removed', 'disabled proxy', 'configured proxy', 'legacy token', 'legacy env']) {
            it(`${mode}, ${chunked ? 'chunked' : 'single'}: verifies outbound host and token`, async t => {
                const f = databaseFixture(t);
                Object.assign(f.env, { TG_BOT_TOKEN: '999:env', TG_CHAT_ID: 'env-chat' });
                const original = { name: 'original', botToken: '111:configured', chatId: 'original-chat',
                    proxyUrl: mode === 'configured proxy' ? 'configured.example' : '' };
                if (mode.includes('proxy')) await f.db.put('manage@sysConfig@upload', JSON.stringify({ telegram: { channels: [original] } }));
                const metadata = { Channel: 'TelegramNew', TgFileId: 'F', TgProxyUrl: 'stale.example', IsChunked: chunked,
                    ...(mode === 'legacy env' ? {} : { ChannelName: 'original', TgChatId: 'original-chat', TgBotId: '111' }),
                    ...(mode === 'legacy token' ? { TgBotToken: '111:legacy' } : {}) };
                f.seed('old.png', chunked ? JSON.stringify([{ index: 0, fileId: 'F', size: 1 }]) : '', metadata);
                const calls = [];
                t.mock.method(globalThis, 'fetch', async url => {
                    const parsed = new URL(url); calls.push(parsed);
                    return parsed.pathname.endsWith('/getFile')
                        ? Response.json({ ok: true, result: { file_path: 'sample.png' } })
                        : new Response('x');
                });
                const route = await fileRoute();
                const result = await route.onRequest({ env: f.env, params: { path: 'old.png' }, request: new Request('https://img.example/file/old.png') });
                if (mode === 'removed') {
                    assert.equal(result.status, 503);
                    assert.equal(calls.length, 0);
                } else {
                    assert.equal(result.status, 200, await result.clone().text());
                    assert.equal(await result.text(), 'x');
                    assert.equal(calls.length, 2);
                    const host = mode === 'configured proxy' ? 'configured.example' : 'api.telegram.org';
                    const token = mode === 'legacy env' ? '999:env' : mode === 'legacy token' ? '111:legacy' : '111:configured';
                    for (const call of calls) { assert.equal(call.hostname, host); assert.ok(call.pathname.includes(`/bot${token}/`)); }
                }
            });
        }
    }
});

describe('multipart backup integrity', () => {
    const exportPage = (env, includeValue = true) => list({ env, request: new Request(`https://img.example/list?includeValue=${includeValue}`) });
    const importFiles = async (env, data) => (await restore({ env, request: new Request('https://img.example/restore', {
        method: 'POST', body: JSON.stringify({ type: 'files', data }),
    }) })).json();
    for (const backend of ['KV', 'D1']) for (const Channel of ['TelegramNew', 'Discord']) {
        it(`${backend} ${Channel}: refuses broken manifests without overwriting a good copy`, async t => {
            const f = databaseFixture(t, backend);
            const config = { telegram: { channels: [{ name: 'backend', botToken: '123:token', chatId: 'chat' }] },
                discord: { channels: [{ name: 'backend', botToken: 'token', channelId: '123' }] } };
            await f.db.put('manage@sysConfig@upload', JSON.stringify(config));
            const metadata = { Channel, ChannelName: 'backend', TimeStamp: 1, FileSizeBytes: 2, TotalChunks: 2, IsChunked: true };
            const key = Channel === 'Discord' ? 'messageId' : 'fileId';
            const parts = [0, 1].map(i => ({ index: i, [key]: String(i + 10), size: 1 }));
            const value = JSON.stringify(parts);
            f.seed('original.png', value, metadata);
            const page = await (await exportPage(f.env)).json();
            assert.equal(page.records[0].value, value);
            assert.equal((await importFiles(f.env, { 'copy.png': page.records[0] })).restoredCount, 1);
            const old = await f.db.getWithMetadata('copy.png');
            for (const bad of [undefined, '', '{', [], '[]', JSON.stringify(parts.slice(1)), JSON.stringify([parts[0], parts[0]]),
                JSON.stringify([parts[0], { ...parts[1], [key]: '' }]), JSON.stringify([parts[0], { ...parts[1], size: 2 }])]) {
                const result = await importFiles(f.env, { 'copy.png': { metadata, value: bad } });
                assert.equal(result.failedCount, 1);
                assert.match(result.errors[0].error, /chunk manifest/);
                assert.deepEqual(await f.db.getWithMetadata('copy.png'), old);
            }
            f.seed('broken.png', '', metadata);
            const rejected = await exportPage(f.env);
            assert.equal(rejected.status, 500);
            assert.match((await rejected.json()).error, /broken.png/);
            assert.equal((await exportPage(f.env, false)).status, 200);
        });
    }
    it('does not return a successful backup when the manifest read throws', async t => {
        const f = databaseFixture(t);
        f.seed('broken.zip', '', { Channel: 'Discord', IsChunked: true, TimeStamp: 1 });
        t.mock.method(f.env.img_url, 'get', async () => { throw new Error('storage unavailable'); });
        assert.equal((await exportPage(f.env)).status, 500);
    });
});

describe('WebDAV URL credentials', () => {
    it('moves URL userinfo to Basic authentication without leaking it into request or MOVE destination URLs', async t => {
        const api = new WebDAVAPI({ baseUrl: 'https://a%40b:p%3Aq@dav.example/root', createDirectory: false });
        let seen;
        t.mock.method(globalThis, 'fetch', async (url, options) => { seen = new Request(url, options); return new Response(null, { status: 204 }); });
        await api.moveFile('before', 'after');
        assert.equal(seen.url, 'https://dav.example/root/before');
        assert.equal(seen.headers.get('Destination'), 'https://dav.example/root/after');
        assert.equal(seen.headers.get('Authorization'), 'Basic ' + Buffer.from('a@b:p:q').toString('base64'));
        assert.equal(new WebDAVAPI({ baseUrl: 'https://u:p@dav.example', headers: { Authorization: 'Bearer chosen' } }).getRequestHeaders().get('Authorization'), 'Bearer chosen');
    });
    it('redacts public URL userinfo from metadata and from public file reads on existing rows', async t => {
        const f = databaseFixture(t);
        const url = 'https://user:secret@cdn.example/root';
        const metadata = { Channel: 'WebDAV', WebDAVBaseUrl: url, WebDAVPublicBaseUrl: url, WebDAVPublicUrl: url + '/photo.png' };
        f.seed('photo.png', '', metadata);
        const api = new WebDAVAPI({ baseUrl: url });
        assert.equal(api.buildPublicUrl('photo.png', url), 'https://cdn.example/root/photo.png');
        assert.equal(JSON.stringify(stripSensitiveMetadata(metadata)).includes('secret'), false);
        let requested;
        t.mock.method(globalThis, 'fetch', async (url, opts) => { requested = new Request(url, opts); return new Response('x'); });
        const response = await (await fileRoute()).onRequest({ env: f.env, params: { path: 'photo.png' }, request: new Request('https://img.example/file/photo.png') });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(requested.url, 'https://cdn.example/root/photo.png');
        assert.equal(requested.headers.has('Authorization'), false);
    });
});
