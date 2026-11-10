import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { stripSensitiveMetadata } from '../functions/utils/metadata/metadataSecurity.js';
import { addFileToIndex } from '../functions/utils/indexManager.js';

function memoryKV(initial = {}) {
    const values = new Map(Object.entries(initial));
    const writes = [];
    return {
        values, writes,
        async get(key) { return values.get(key)?.value ?? null; },
        async getWithMetadata(key) { return values.get(key) ?? null; },
        async put(key, value, options = {}) {
            writes.push({ key, value, options });
            values.set(key, { value, metadata: options.metadata });
        },
        async delete(key) { values.delete(key); },
    };
}

describe('file metadata credential isolation', () => {
    it('removes secret fields without mutating the upload metadata', async () => {
        const kv = memoryKV();
        const db = createDatabaseAdapter({ img_url: kv });
        const metadata = {
            Channel: 'S3', ChannelName: 'primary', S3FileKey: 'photo.jpg',
            S3AccessKeyId: 'access', S3SecretAccessKey: 'secret',
        };
        await db.put('photo.jpg', '', { metadata });
        assert.equal(metadata.S3SecretAccessKey, 'secret');
        assert.equal(kv.values.get('photo.jpg').metadata.S3SecretAccessKey, undefined);
        assert.equal(kv.values.get('photo.jpg').metadata.S3FileKey, 'photo.jpg');
        assert.equal(stripSensitiveMetadata({ TgBotToken: 'token', DiscordBotToken: 'token', HfToken: 'token', WebDAVPassword: 'pw' }).WebDAVPassword, undefined);
        const webdav = stripSensitiveMetadata({ WebDAVBaseUrl: 'https://user:password@example.com/dav', WebDAVHeaders: { Authorization: 'secret' } });
        assert.equal(webdav.WebDAVBaseUrl, 'https://example.com/dav');
        assert.equal(webdav.WebDAVHeaders, undefined);
    });

    it('also strips file metadata and the Telegram token index column in D1', async () => {
        let bound;
        const d1 = { prepare() { return { bind(...values) { bound = values; return { async run() {} }; } }; } };
        const db = createDatabaseAdapter({ img_d1: d1 });
        await db.put('photo.jpg', '', { metadata: {
            Channel: 'TelegramNew', TgFileId: 'file', TgBotToken: 'secret', TimeStamp: 1,
        } });
        assert.equal(JSON.parse(bound[2]).TgBotToken, undefined);
        assert.equal(bound[16], null);
    });

    it('resolves new records from channel config and retains old-record fallback', async () => {
        const kv = memoryKV({
            'manage@sysConfig@upload': { value: JSON.stringify({
                s3: { channels: [{ name: 'primary', endpoint: 'https://s3.example', bucketName: 'bucket', accessKeyId: 'access', secretAccessKey: 'secret' }] },
            }) },
        });
        const env = { img_url: kv };
        const fresh = await hydrateFileCredentials(env, { Channel: 'S3', ChannelName: 'primary', S3FileKey: 'photo.jpg' });
        assert.equal(fresh.S3SecretAccessKey, 'secret');
        assert.equal(fresh.S3FileKey, 'photo.jpg');
        const legacy = await hydrateFileCredentials(env, { Channel: 'Discord', ChannelName: 'removed', DiscordBotToken: 'old-secret' });
        assert.equal(legacy.DiscordBotToken, 'old-secret');
    });

    it('hydrates Telegram, Discord, Hugging Face and WebDAV from current channels', async () => {
        const kv = memoryKV({
            'manage@sysConfig@upload': { value: JSON.stringify({
                telegram: { channels: [{ name: 'tg', botToken: 'tg-token', chatId: 'chat' }] },
                discord: { channels: [{ name: 'discord', botToken: 'discord-token', channelId: 'channel' }] },
                huggingface: { channels: [{ name: 'hf', token: 'hf-token', repo: 'owner/repo', isPrivate: true }] },
                webdav: { channels: [{ name: 'dav', baseUrl: 'https://dav.example', username: 'user', password: 'pw' }] },
            }) },
        });
        const env = { img_url: kv };
        const examples = [
            [{ Channel: 'TelegramNew', ChannelName: 'tg' }, 'TgBotToken', 'tg-token'],
            [{ Channel: 'Discord', ChannelName: 'discord' }, 'DiscordBotToken', 'discord-token'],
            [{ Channel: 'HuggingFace', ChannelName: 'hf' }, 'HfToken', 'hf-token'],
            [{ Channel: 'WebDAV', ChannelName: 'dav' }, 'WebDAVPassword', 'pw'],
        ];
        for (const [metadata, field, expected] of examples) {
            const hydrated = await hydrateFileCredentials(env, metadata);
            assert.equal(hydrated[field], expected);
            assert.equal(metadata[field], undefined);
        }
    });

    it('keeps credentials out of newly recorded index operations', async () => {
        const kv = memoryKV();
        await addFileToIndex({ env: { img_url: kv } }, 'photo.jpg', {
            Channel: 'S3', S3SecretAccessKey: 'secret', TgBotToken: 'token',
        });
        const operation = kv.writes.find(write => write.key.startsWith('manage@index@operation_'));
        assert.ok(operation);
        assert.equal(operation.value.includes('secret'), false);
        assert.equal(operation.value.includes('token'), false);
    });
});
