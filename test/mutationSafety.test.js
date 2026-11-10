import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../functions/utils/metadata/writeSafety.js';
import { prepareMetadataForStorage } from '../functions/utils/metadata/webdavIdentity.js';
import { resolveWebDAVConfig } from '../functions/utils/webdavConfig.js';
import { DiscordAPI } from '../functions/utils/storage/discordAPI.js';
import { loadFunction } from './helpers/loadFunction.js';
import { databaseFixture } from './helpers/databaseFixture.js';

const noCache = { purgeCFCache: async () => {}, purgeRandomFileListCache: async () => {}, purgePublicFileListCache: async () => {} };
const channels = {
    s3: { name: 's3', endpoint: 'https://s3.example', bucketName: 'bucket', accessKeyId: 'access-secret', secretAccessKey: 's3-secret' },
    telegram: { name: 'tg', botToken: '123:tg-secret', chatId: 'chat' },
    discord: { name: 'discord', botToken: 'discord-secret', channelId: 'chat' },
    huggingface: { name: 'hf', token: 'hf-secret', repo: 'owner/repo' },
    webdav: { name: 'dav', baseUrl: 'https://dav.example/root', username: 'alice', password: 'dav-secret', headers: { 'X-Api-Key': 'header-secret' } },
};
const config = Object.fromEntries(Object.entries(channels).map(([key, value]) => [key, { channels: [value] }]));
const examples = [
    { Channel: 'S3', ChannelName: 's3', S3Endpoint: channels.s3.endpoint, S3BucketName: 'bucket', S3FileKey: 'old.png' },
    { Channel: 'TelegramNew', ChannelName: 'tg', TgBotId: '123', TgChatId: 'chat', TgFileId: 'file' },
    { Channel: 'Discord', ChannelName: 'discord', DiscordChannelId: 'chat', DiscordMessageId: '111' },
    { Channel: 'HuggingFace', ChannelName: 'hf', HfRepo: 'owner/repo', HfFilePath: 'old.png' },
    { Channel: 'WebDAV', ChannelName: 'dav', WebDAVBaseUrl: channels.webdav.baseUrl, WebDAVFilePath: 'old.png' },
    { Channel: 'CloudflareR2', ChannelName: 'r2' },
];

describe('rename response credential isolation', () => {
    for (const backend of ['KV', 'D1']) for (const example of examples) for (const legacy of [false, true]) {
        it(`${backend}: ${legacy ? 'legacy' : 'clean'} ${example.Channel} rename returns only persisted safe metadata`, async t => {
            const f = databaseFixture(t, backend);
            await f.db.put('manage@sysConfig@upload', JSON.stringify(config));
            let metadata = await hydrateFileCredentials(f.env, example);
            if (!legacy) metadata = await prepareMetadataForStorage(metadata);
            f.seed('old.png', '', metadata);
            f.env.img_r2 = { async get() { return { body: 'content' }; }, async put() {}, async delete() {} };
            const route = await loadFunction('functions/api/manage/rename/[[path]].js', {
                ...noCache, getDatabase: createDatabaseAdapter, hydrateFileCredentials, assertLegacyWriteSafe,
                prepareMetadataForStorage, resolveWebDAVConfig, sanitizeUploadFolder: v => v,
                S3Client: class { async send() {} }, CopyObjectCommand: class {}, DeleteObjectCommand: class {},
                WebDAVAPI: class { async moveFile() {} }, moveFileInIndex: async () => {},
            });
            const response = await route.onRequest({ env: f.env, params: { path: 'old.png' }, waitUntil() {}, request: new Request('https://img.example/rename/old.png', {
                method: 'POST', body: JSON.stringify({ newFileId: 'new.png' }),
            }) });
            assert.equal(response.status, 200, await response.clone().text());
            const body = await response.json();
            assert.equal(body.success, true);
            assert.deepEqual(body.metadata, (await f.db.getWithMetadata('new.png')).metadata);
            assert.equal((await f.db.getWithMetadata('old.png'))?.metadata ?? null, null);
            const serialized = JSON.stringify(body);
            for (const field of ['S3AccessKeyId', 'S3SecretAccessKey', 'TgBotToken', 'DiscordBotToken', 'HfToken', 'WebDAVUsername', 'WebDAVPassword', 'WebDAVHeaders']) {
                assert.equal(Object.hasOwn(body.metadata, field), false);
            }
            assert.equal(serialized.includes('-secret'), false);
            if (example.Channel === 'WebDAV') assert.match(body.metadata.WebDAVAccountId, /^[0-9a-f]{64}$/);
        });
    }
});

const manifest = [{ index: 0, messageId: '111', size: 10 }, { index: 1, messageId: '222', size: 10 }];
const chunkMetadata = { Channel: 'Discord', ChannelName: 'discord', DiscordChannelId: 'chat', IsChunked: true, TotalChunks: 2, TimeStamp: 1 };

async function deletionRoute(indexUpdates = []) {
    return loadFunction('functions/api/manage/delete/[[path]].js', {
        ...noCache, getDatabase: createDatabaseAdapter, hydrateFileCredentials, DiscordAPI,
        removeFileFromIndex: async (ctx, id) => indexUpdates.push(id),
    });
}

describe('Discord chunk deletion and cleanup', () => {
    for (const backend of ['KV', 'D1']) {
        it(`${backend}: retains a failed manifest and index, then retries missing messages idempotently`, async t => {
            const f = databaseFixture(t, backend);
            await f.db.put('manage@sysConfig@upload', JSON.stringify(config));
            f.seed('large.zip', JSON.stringify(manifest), chunkMetadata);
            const original = await f.db.getWithMetadata('large.zip');
            const remote = new Set(['111', '222']);
            const calls = [];
            let fail = true;
            t.mock.method(globalThis, 'fetch', async (url, options) => {
                assert.equal(options.method, 'DELETE');
                const id = url.split('/').pop(); calls.push(id);
                if (id === '222' && fail) return Response.json({ code: 50013 }, { status: 403 });
                return remote.delete(id) ? new Response(null, { status: 204 }) : Response.json({ code: 10008 }, { status: 404 });
            });
            const indexUpdates = [];
            const route = await deletionRoute(indexUpdates);
            const invoke = () => route.onRequest({ env: f.env, params: { path: 'large.zip' }, waitUntil() {}, request: new Request('https://img.example/delete/large.zip') });
            assert.equal((await invoke()).status, 400);
            assert.deepEqual(await f.db.getWithMetadata('large.zip'), original);
            assert.deepEqual(indexUpdates, []);
            assert.deepEqual([...remote], ['222']);
            fail = false;
            assert.equal((await invoke()).status, 200);
            assert.equal((await f.db.getWithMetadata('large.zip'))?.metadata ?? null, null);
            assert.deepEqual(calls, ['111', '222', '111', '222']);
            assert.deepEqual(indexUpdates, ['large.zip']);
        });

        for (const [name, value, extra] of [
            ['invalid JSON', '{', {}], ['empty', '[]', {}], ['object', '{}', {}],
            ['missing ID', JSON.stringify([{ index: 0, messageId: '111' }, { index: 1 }]), {}],
            ['numeric ID', JSON.stringify([{ index: 0, messageId: 111 }, manifest[1]]), {}],
            ['duplicate index', JSON.stringify([manifest[0], manifest[0]]), {}],
            ['missing chunk', JSON.stringify([manifest[0]]), {}],
            ['invalid count', JSON.stringify(manifest), { TotalChunks: 0 }],
        ]) {
            it(`${backend}: rejects ${name} before any remote deletion`, async t => {
                const f = databaseFixture(t, backend);
                await f.db.put('manage@sysConfig@upload', JSON.stringify(config));
                f.seed('large.zip', value, { ...chunkMetadata, ...extra });
                let calls = 0;
                t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 204 }); });
                const route = await deletionRoute();
                assert.equal(await route.deleteFile(f.env, 'large.zip', '', new URL('https://img.example')), false);
                assert.equal(calls, 0);
                assert.equal((await f.db.getWithMetadata('large.zip')).value, value);
            });
        }
    }

    it('automatic D1 cleanup counts failures and removes the index only after all chunks are gone', async t => {
        const f = databaseFixture(t, 'D1');
        await f.db.put('manage@sysConfig@upload', JSON.stringify(config));
        f.seed('large.zip', JSON.stringify(manifest), chunkMetadata);
        let fail = true;
        const remote = new Set(['111', '222']);
        t.mock.method(globalThis, 'fetch', async url => {
            const id = url.split('/').pop();
            if (id === '222' && fail) throw new Error('network unavailable');
            return remote.delete(id) ? new Response(null, { status: 204 }) : Response.json({ code: 10008 }, { status: 404 });
        });
        const route = await deletionRoute();
        const indexUpdates = [];
        const cleanup = await loadFunction('functions/utils/cleanupManager.js', {
            getDatabase: createDatabaseAdapter, deleteFile: route.deleteFile,
            batchRemoveFilesFromIndex: async (ctx, ids) => indexUpdates.push(...ids), mergeOperationsToIndex: async () => {},
        });
        const options = { config: { dryRun: false, retentionDays: 1 }, origin: 'https://img.example' };
        let result = await cleanup.runCleanup({ env: f.env }, options);
        assert.equal(result.failed, 1); assert.equal(result.deleted, 0); assert.deepEqual(indexUpdates, []);
        fail = false;
        result = await cleanup.runCleanup({ env: f.env }, options);
        assert.equal(result.failed, 0); assert.equal(result.deleted, 1); assert.deepEqual(indexUpdates, ['large.zip']);
    });

    it('handles the KV missing-record shape as an idempotent no-op', async () => {
        const route = await loadFunction('functions/api/manage/delete/[[path]].js', {
            getDatabase: () => ({ async getWithMetadata() { return { value: null, metadata: null }; } }),
        });
        assert.equal(await route.deleteFile({}, 'missing.png', '', new URL('https://img.example')), true);
    });
});
