import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { stripSensitiveMetadata } from '../functions/utils/metadata/metadataSecurity.js';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';

// Exercise both real adapters; only the KV/D1 transport is in memory.
function fixture(backend) {
    const kv = memoryDatabase();
    const records = kv.records;
    const env = backend === 'KV' ? { img_url: kv } : { img_d1: {
        prepare(sql) {
            return { bind(...args) { return {
                async first() {
                    assert.match(sql, /^SELECT (\* FROM files WHERE id|value FROM settings WHERE key) = \?$/);
                    const row = records.get(args[0]);
                    return row ? { value: row.value, metadata: JSON.stringify(row.metadata) } : null;
                },
                async run() {
                    assert.match(sql, /^INSERT OR REPLACE INTO (files|settings) /);
                    records.set(args[0], { value: args[1], metadata: sql.includes('INTO files ')
                        ? JSON.parse(args[2]) : {} });
                },
            }; } };
        },
    } };
    return { env, records, db: createDatabaseAdapter(env) };
}

const examples = [
    { group: 's3', metadata: { Channel: 'S3', ChannelName: 's3', S3Endpoint: 'https://s3.example', S3BucketName: 'bucket', S3AccessKeyId: 'id', S3SecretAccessKey: 'secret' },
        channel: { name: 's3', endpoint: 'https://s3.example', bucketName: 'bucket', accessKeyId: 'id', secretAccessKey: 'secret' }, secret: 'S3SecretAccessKey', incomplete: { secretAccessKey: '' }, wrong: { bucketName: 'other' } },
    { group: 'telegram', metadata: { Channel: 'TelegramNew', TgBotToken: '123:secret', TgChatId: 'chat' },
        channel: { name: 'tg', botToken: '123:secret', chatId: 'chat' }, secret: 'TgBotToken', incomplete: { botToken: '' }, wrong: { botToken: '999:other' } },
    { group: 'discord', metadata: { Channel: 'Discord', ChannelName: 'discord', DiscordChannelId: 'chat', DiscordBotToken: 'secret' },
        channel: { name: 'discord', channelId: 'chat', botToken: 'secret' }, secret: 'DiscordBotToken', incomplete: { botToken: '' }, wrong: { channelId: 'other' } },
    { group: 'huggingface', metadata: { Channel: 'HuggingFace', ChannelName: 'hf', HfRepo: 'owner/repo', HfToken: 'secret' },
        channel: { name: 'hf', repo: 'owner/repo', token: 'secret' }, secret: 'HfToken', incomplete: { token: '' }, wrong: { repo: 'owner/other' } },
    { group: 'webdav', metadata: { Channel: 'WebDAV', ChannelName: 'dav', WebDAVBaseUrl: 'https://dav.example/root', WebDAVUsername: 'alice', WebDAVPassword: 'secret' },
        channel: { name: 'dav', baseUrl: 'https://dav.example/root', username: 'alice', password: 'secret' }, secret: 'WebDAVPassword', incomplete: { password: '' }, wrong: { username: 'bob' } },
    { group: 'webdav', metadata: { Channel: 'WebDAV', ChannelName: 'dav-url', WebDAVBaseUrl: 'https://alice:secret@dav.example/root' },
        channel: { name: 'dav-url', baseUrl: 'https://dav.example/root', username: 'alice', password: 'secret' }, secret: 'WebDAVPassword', incomplete: { password: '' }, wrong: { username: 'bob' } },
];

async function restore(env, type, data) {
    const route = await loadFunction('functions/api/manage/batch/restore/chunk.js', { getDatabase: createDatabaseAdapter });
    const response = await route.onRequestPost({ env, request: new Request('https://img.example/api/manage/batch/restore/chunk', {
        method: 'POST', body: JSON.stringify({ type, data }),
    }) });
    assert.equal(response.status, 200);
    return response.json();
}

describe('legacy backup restore safety', () => {
    for (const backend of ['KV', 'D1']) {
        it(`${backend}: rejects a channel match that becomes ambiguous after stripping the token`, async () => {
            const { env, records } = fixture(backend);
            await restore(env, 'settings', { 'sysConfig@upload': { discord: { channels: [
                { name: 'one', channelId: 'chat', botToken: 'one' },
                { name: 'two', channelId: 'chat', botToken: 'two' },
            ] } } });
            const result = await restore(env, 'files', { 'legacy.png': { metadata: {
                Channel: 'Discord', DiscordChannelId: 'chat', DiscordBotToken: 'one',
            } } });
            assert.equal(result.failedCount, 1);
            assert.equal(records.has('legacy.png'), false);
        });

        for (const example of examples) {
            const { metadata, channel, group, secret } = example;
            it(`${backend}: rejects orphaned ${metadata.ChannelName || metadata.Channel} imports, then succeeds after restoring settings`, async () => {
                const { env, records, db } = fixture(backend);
                const original = structuredClone(metadata);
                const data = { 'legacy.png': { value: 'chunk manifest', metadata }, 'safe.png': { metadata: { Channel: 'CloudflareR2' } } };
                const failed = await restore(env, 'files', data);
                assert.equal(failed.failedCount, 1);
                assert.equal(failed.restoredCount, 1);
                assert.equal(failed.errors[0].key, 'legacy.png');
                assert.match(failed.errors[0].error, /restore its matching storage channel.*retry/);
                assert.equal(records.has('legacy.png'), false);
                assert.equal(records.has('safe.png'), true);
                const settings = await restore(env, 'settings', { 'sysConfig@upload': { [group]: { channels: [channel] } } });
                assert.equal(settings.failedCount, 0);
                const result = await restore(env, 'files', data);
                assert.equal(result.restoredCount, 2);
                assert.equal(result.failedCount, 0);
                const saved = await db.getWithMetadata('legacy.png');
                assert.equal(saved.value, 'chunk manifest');
                assert.deepEqual(saved.metadata, stripSensitiveMetadata(saved.metadata));
                assert.ok((await hydrateFileCredentials(env, saved.metadata))[secret]);
                assert.deepEqual(metadata, original);
            });

            for (const problem of ['incomplete', 'wrong']) {
                it(`${backend}: rejects ${problem} channel for incoming ${metadata.ChannelName || metadata.Channel} even over an existing clean row`, async () => {
                    const { env, records } = fixture(backend);
                    const previous = { value: 'original value', metadata: { Channel: 'CloudflareR2' } };
                    records.set('legacy.png', structuredClone(previous));
                    await restore(env, 'settings', { 'sysConfig@upload': { [group]: { channels: [{ ...channel, ...example[problem] }] } } });
                    const result = await restore(env, 'files', { 'legacy.png': { metadata } });
                    assert.equal(result.restoredCount, 0);
                    assert.equal(result.failedCount, 1);
                    assert.deepEqual(records.get('legacy.png'), previous);
                });
            }
        }
    }
});
