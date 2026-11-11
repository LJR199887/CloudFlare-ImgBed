import { batchAddFilesToIndex } from '../functions/utils/indexManager.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { prepareMetadataForBackup, assertRestoredFileSafe } from '../functions/utils/metadata/writeSafety.js';
import { getWebDAVAccountId } from '../functions/utils/metadata/webdavIdentity.js';
import { resolveWebDAVConfig } from '../functions/utils/webdavConfig.js';
import { loadChannelConfig } from '../functions/utils/metadata/channelConfig.js';
import { loadFunction } from './helpers/loadFunction.js';
import { databaseFixture } from './helpers/databaseFixture.js';

async function exportFiles(env) {
    const route = await loadFunction('functions/api/manage/batch/list.js', { getDatabase: createDatabaseAdapter, prepareMetadataForBackup, loadChannelConfig });
    return route.onRequestGet({ env, request: new Request('https://img.example/api/manage/batch/list?includeValue=true') });
}

async function restore(env, data) {
    const route = await loadFunction('functions/api/manage/batch/restore/chunk.js', { getDatabase: createDatabaseAdapter, assertRestoredFileSafe, batchAddFilesToIndex });
    return (await route.onRequestPost({ env, request: new Request('https://img.example/restore', {
        method: 'POST', body: JSON.stringify({ type: 'files', data }),
    }) })).json();
}

describe('backup account identity round trips', () => {
    it('loads channel settings only once for a page of original unbound WebDAV records', async t => {
        const f = databaseFixture(t);
        const metadata = { Channel: 'WebDAV', ChannelName: 'dav', WebDAVBaseUrl: 'https://dav.example/root', TimeStamp: 1 };
        for (let i = 0; i < 30; i++) f.seed(`${i}.png`, '', metadata);
        await f.db.put('manage@sysConfig@upload', JSON.stringify({ webdav: { channels: [{ name: 'dav', baseUrl: metadata.WebDAVBaseUrl, username: 'alice', password: 'secret' }] } }));
        const get = f.env.img_url.get.bind(f.env.img_url);
        let configReads = 0;
        t.mock.method(f.env.img_url, 'get', async key => { if (key === 'manage@sysConfig@upload') configReads++; return get(key); });
        const response = await exportFiles(f.env);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).records.length, 30);
        assert.equal(configReads, 1);
    });

    for (const backend of ['KV', 'D1']) {
        for (const auth of ['basic', 'headers', 'url', 'anonymous', 'already-bound']) {
            it(`${backend}: preserves ${auth} identity through export, restore and channel rename`, async t => {
                const original = databaseFixture(t, backend);
                const target = databaseFixture(t, backend);
                const channel = { name: 'dav', baseUrl: 'https://dav.example/root', username: 'alice', password: 'old-secret' };
                let credentials = { WebDAVUsername: channel.username, WebDAVPassword: channel.password };
                if (auth === 'headers') {
                    channel.username = ''; channel.password = ''; channel.headers = { Authorization: 'Bearer header-secret' };
                    credentials = { WebDAVHeaders: channel.headers };
                } else if (auth === 'url') {
                    credentials = { WebDAVBaseUrl: 'https://alice:old-secret@dav.example/root' };
                } else if (auth === 'anonymous') {
                    channel.username = ''; channel.password = '';
                    credentials = { WebDAVUsername: '', WebDAVPassword: '' };
                } else if (auth === 'already-bound') {
                    credentials = { WebDAVAccountId: await getWebDAVAccountId(channel) };
                }
                const metadata = { Channel: 'WebDAV', ChannelName: 'dav', WebDAVBaseUrl: channel.baseUrl, WebDAVFilePath: 'photo.png', TimeStamp: 1, ...credentials };
                original.seed('photo.png', '', metadata);
                // The current channel can already belong to another account.
                const wrong = { ...channel, username: 'bob', password: 'bob-secret', headers: {} };
                await original.db.put('manage@sysConfig@upload', JSON.stringify({ webdav: { channels: [wrong] } }));
                const exported = await exportFiles(original.env);
                assert.equal(exported.status, 200, await exported.clone().text());
                const record = (await exported.json()).records[0];
                assert.equal(record.metadata.WebDAVAccountId, await getWebDAVAccountId(channel));
                const serialized = JSON.stringify(record);
                for (const secret of ['old-secret', 'header-secret', 'WebDAVUsername', 'WebDAVPassword', 'WebDAVHeaders']) assert.equal(serialized.includes(secret), false);
                assert.deepEqual((await original.db.getWithMetadata('photo.png')).metadata, metadata);
                const data = { 'photo.png': { metadata: record.metadata } };
                // Both missing and mismatched configurations must fail before writing.
                assert.equal((await restore(target.env, data)).failedCount, 1);
                await target.db.put('manage@sysConfig@upload', JSON.stringify({ webdav: { channels: [wrong] } }));
                assert.equal((await restore(target.env, data)).failedCount, 1);
                assert.equal((await target.db.getWithMetadata('photo.png'))?.metadata ?? null, null);
                const matching = { ...channel, name: 'renamed' };
                if (channel.username) matching.password = 'rotated-secret';
                await target.db.put('manage@sysConfig@upload', JSON.stringify({ webdav: { channels: [matching] } }));
                assert.equal((await restore(target.env, data)).restoredCount, 1);
                const persisted = (await target.db.getWithMetadata('photo.png')).metadata;
                assert.equal(persisted.WebDAVAccountId, record.metadata.WebDAVAccountId);
                assert.equal((await resolveWebDAVConfig(target.env, persisted)).username, channel.username);
                await target.db.put('manage@sysConfig@upload', JSON.stringify({ webdav: { channels: [wrong] } }));
                // Removing/changing the channel never falls back to another account.
                const resolved = await resolveWebDAVConfig(target.env, persisted);
                if (auth === 'anonymous') assert.equal(resolved.username, '');
                else assert.equal(resolved, null);
            });
        }

        it(`${backend}: binds original unbound WebDAV records only at export, rejects already-unbound backups`, async t => {
            const f = databaseFixture(t, backend);
            const metadata = { Channel: 'WebDAV', ChannelName: 'dav', WebDAVBaseUrl: 'https://dav.example/root', TimeStamp: 1 };
            f.seed('photo.png', '', metadata);
            assert.equal((await exportFiles(f.env)).status, 500);
            const channel = { name: 'dav', baseUrl: metadata.WebDAVBaseUrl, username: 'alice', password: 'secret' };
            await f.db.put('manage@sysConfig@upload', JSON.stringify({ webdav: { channels: [channel] } }));
            const exported = await (await exportFiles(f.env)).json();
            assert.equal(exported.records[0].metadata.WebDAVAccountId, await getWebDAVAccountId(channel));
            const result = await restore(f.env, { 'other.png': { metadata } });
            assert.equal(result.failedCount, 1);
            assert.match(result.errors[0].error, /new backup/);
        });

        it(`${backend}: validates redacted non-WebDAV backups and rejects malformed records`, async t => {
            const f = databaseFixture(t, backend);
            const metadata = { Channel: 'Discord', ChannelName: 'd', DiscordChannelId: 'chat' };
            assert.equal((await restore(f.env, { 'file.png': { metadata } })).failedCount, 1);
            await f.db.put('manage@sysConfig@upload', JSON.stringify({ discord: { channels: [{ name: 'd', channelId: 'chat', botToken: 'secret' }] } }));
            assert.equal((await restore(f.env, { 'file.png': { metadata } })).restoredCount, 1);
            for (const value of [null, {}, { value: 'orphaned manifest' }, { metadata: [] }]) {
                assert.equal((await restore(f.env, { 'bad.png': value })).failedCount, 1);
            }
            assert.equal((await restore(f.env, { 'manage@bad': { metadata: {} } })).failedCount, 1);
        });
    }
});
