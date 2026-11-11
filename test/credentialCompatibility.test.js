import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { D1Database } from '../functions/utils/d1Database.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { resolveWebDAVConfig } from '../functions/utils/webdavConfig.js';
import { assertLegacyWriteSafe } from '../functions/utils/metadata/writeSafety.js';
import { stripSensitiveMetadata } from '../functions/utils/metadata/metadataSecurity.js';
import { loadFunction } from './helpers/loadFunction.js';

function fixture(config = {}, metadata) {
    const rows = new Map([['manage@sysConfig@upload', { value: JSON.stringify(config) }]]);
    if (metadata) rows.set('file.png', { value: '', metadata: structuredClone(metadata) });
    const kv = {
        async get(k) { return rows.get(k)?.value ?? null; },
        async getWithMetadata(k) { return structuredClone(rows.get(k) ?? null); },
        async put(k, value, options = {}) { rows.set(k, { value, metadata: structuredClone(options.metadata) }); },
        async delete(k) { rows.delete(k); },
    };
    const env = { img_url: kv };
    return { rows, env, db: createDatabaseAdapter(env) };
}

describe('credential compatibility regressions', () => {
    it('rejects unrelated KV updates instead of erasing orphaned legacy credentials', async () => {
        const metadata = { Channel: 'Discord', ChannelName: 'removed', DiscordChannelId: 'chat', DiscordBotToken: 'old-secret' };
        const { rows, db } = fixture({}, metadata);
        await assert.rejects(db.put('file.png', '', { metadata: { ...metadata, Tags: ['new'] } }), /restore its matching storage channel/);
        assert.deepEqual(rows.get('file.png').metadata, metadata);
        // An import/old client that omits secrets must not bypass the guard.
        await assert.rejects(db.put('file.png', '', { metadata: stripSensitiveMetadata(metadata) }), /restore its matching storage channel/);
    });

    it('guards D1 writes before changing any row', async () => {
        let wrote = false;
        const db = new D1Database({ prepare() { return { bind() { return { async run() { wrote = true; } }; } }; } });
        db.getWithMetadata = async () => ({ value: '', metadata: { Channel: 'HuggingFace', HfRepo: 'old/repo', HfToken: 'secret' } });
        db.get = async () => null;
        await assert.rejects(db.putFile('file.png', '', { metadata: {} }), /restore its matching storage channel/);
        assert.equal(wrote, false);
    });

    it('permits a legacy update once a matching credential-bearing channel exists', async () => {
        const metadata = { Channel: 'Discord', ChannelName: 'old-name', DiscordChannelId: 'chat', DiscordBotToken: 'old-token' };
        const { db, rows } = fixture({ discord: { channels: [{ name: 'renamed', channelId: 'chat', botToken: 'current-token' }] } }, metadata);
        await db.put('file.png', '', { metadata: { ...metadata, Tags: ['new'] } });
        assert.equal(rows.get('file.png').metadata.DiscordBotToken, undefined);
    });

    it('resolves renamed Telegram and Discord channels by non-secret identity', async () => {
        const { env } = fixture({
            telegram: { channels: [{ name: 'renamed-tg', botToken: '123:rotated-secret', chatId: '-100' }] },
            discord: { channels: [{ name: 'renamed-discord', botToken: 'discord-secret', channelId: 'chat' }] },
        });
        const tg = await hydrateFileCredentials(env, { Channel: 'TelegramNew', ChannelName: 'old-tg', TgBotId: '123', TgChatId: '-100' });
        assert.equal(tg.TgBotToken, '123:rotated-secret');
        const discord = await hydrateFileCredentials(env, { Channel: 'Discord', ChannelName: 'old-discord', DiscordChannelId: 'chat' });
        assert.equal(discord.DiscordBotToken, 'discord-secret');
        assert.equal(stripSensitiveMetadata({ TgBotToken: '123:secret' }).TgBotId, '123');
    });

    it('does not choose an arbitrary bot or a default environment bot on ambiguous identity', async () => {
        const { env } = fixture({ discord: { channels: [
            { name: 'one', channelId: 'chat', botToken: 'one' }, { name: 'two', channelId: 'chat', botToken: 'two' },
        ] } });
        assert.equal((await hydrateFileCredentials(env, { Channel: 'Discord', ChannelName: 'old', DiscordChannelId: 'chat' })).DiscordBotToken, undefined);
        env.TG_BOT_TOKEN = '999:wrong-bot';
        env.TG_CHAT_ID = '-100';
        assert.equal((await hydrateFileCredentials(env, { Channel: 'TelegramNew', ChannelName: 'removed', TgBotId: '123', TgChatId: '-100' })).TgBotToken, undefined);
    });

    it('never rebinds an S3 delete to a replacement bucket with the same channel name', async () => {
        const metadata = { Channel: 'S3', ChannelName: 'primary', S3Endpoint: 'https://s3.example', S3BucketName: 'bucket-A', S3FileKey: 'file.png', S3AccessKeyId: 'old-id', S3SecretAccessKey: 'old-secret' };
        const { env, rows } = fixture({ s3: { channels: [{ name: 'primary', endpoint: 'https://s3.example', bucketName: 'bucket-B', accessKeyId: 'new-id', secretAccessKey: 'new-secret' }] } }, metadata);
        let bucket;
        const route = await loadFunction('functions/api/manage/delete/[[path]].js', {
            getDatabase: createDatabaseAdapter, hydrateFileCredentials,
            S3Client: class { async send(command) { bucket = command.input.Bucket; } },
            DeleteObjectCommand: class { constructor(input) { this.input = input; } },
            purgeCFCache: async () => {}, purgeRandomFileListCache: async () => {}, purgePublicFileListCache: async () => {},
        });
        assert.equal(await route.deleteFile(env, 'file.png', 'https://img.example/file/file.png', new URL('https://img.example')), true);
        assert.equal(bucket, 'bucket-A');
        assert.equal(rows.has('file.png'), false);
    });

    it('does not rebind repositories or WebDAV roots by display name', async () => {
        const { env } = fixture({
            huggingface: { channels: [{ name: 'hf', repo: 'new/repo', token: 'new-token' }] },
            webdav: { channels: [{ name: 'dav', baseUrl: 'https://new.example/dav', password: 'new-password' }] },
        });
        const hf = await hydrateFileCredentials(env, { Channel: 'HuggingFace', ChannelName: 'hf', HfRepo: 'old/repo', HfToken: 'old-token' });
        assert.equal(hf.HfRepo, 'old/repo');
        assert.equal(hf.HfToken, 'old-token');
        const dav = await resolveWebDAVConfig(env, { Channel: 'WebDAV', ChannelName: 'dav', WebDAVBaseUrl: 'https://old.example/dav', WebDAVPassword: 'old-password' });
        assert.equal(dav.baseUrl, 'https://old.example/dav');
        assert.equal(dav.password, 'old-password');
    });

    for (const operation of ['move', 'rename']) {
        it(`rejects unsafe legacy ${operation} before copying or deleting storage objects`, async () => {
            const metadata = { Channel: 'S3', ChannelName: 'removed', S3Endpoint: 'https://s3.example', S3BucketName: 'old', S3FileKey: 'file.png', S3AccessKeyId: 'id', S3SecretAccessKey: 'secret' };
            const { env, rows } = fixture({}, metadata);
            let mutated = false;
            const route = await loadFunction(`functions/api/manage/${operation}/[[path]].js`, {
                getDatabase: createDatabaseAdapter, assertLegacyWriteSafe, hydrateFileCredentials,
                sanitizeUploadFolder: value => value,
                S3Client: class { async send() { mutated = true; } },
                CopyObjectCommand: class {}, DeleteObjectCommand: class {},
            });
            const request = new Request(`https://img.example/api/manage/${operation}/file.png?dist=other`, {
                method: 'POST', body: JSON.stringify({ newFileId: 'renamed.png' }),
            });
            const response = await route.onRequest({ env, request, params: { path: 'file.png' }, waitUntil() {} });
            assert.notEqual(response.status, 200);
            assert.equal(mutated, false);
            assert.deepEqual(rows.get('file.png').metadata, metadata);
        });
    }
});
