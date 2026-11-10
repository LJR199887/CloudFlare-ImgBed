import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadFunction } from './helpers/loadFunction.js';
import { DiscordAPI } from '../functions/utils/storage/discordAPI.js';

describe('deletion with credential-free records', () => {
    for (const available of [true, false]) {
        it(`${available ? 'uses channel credentials' : 'keeps the record when credentials are missing'}`, async () => {
            let removed = false;
            const db = {
                async getWithMetadata() { return { value: '', metadata: { Channel: 'Discord', ChannelName: 'primary', DiscordMessageId: 'message' } }; },
                async delete() { removed = true; },
            };
            const route = await loadFunction('functions/api/manage/delete/[[path]].js', {
                getDatabase: () => db,
                hydrateFileCredentials: async (env, metadata) => available
                    ? { ...metadata, DiscordBotToken: 'token', DiscordChannelId: 'channel' }
                    : metadata,
                DiscordAPI: class { async deleteMessage() { return true; } },
                purgeCFCache: async () => {},
                purgeRandomFileListCache: async () => {},
                purgePublicFileListCache: async () => {},
            });
            const result = await route.deleteFile({}, 'photo.png', 'https://img.example/file/photo.png', new URL('https://img.example'));
            assert.equal(result, available);
            assert.equal(removed, available);
        });
    }
});

describe('Discord deletion idempotency', () => {
    const cases = [
        { name: 'successful delete', status: 204, body: null, success: true },
        { name: 'explicit Unknown Message', status: 404, body: { code: 10008 }, success: true },
        { name: 'Unknown Channel', status: 404, body: { code: 10003 }, success: false },
        { name: 'generic 404', status: 404, body: {}, success: false },
        { name: 'non-JSON 404', status: 404, body: '<html>Not Found</html>', success: false },
        { name: 'null JSON 404', status: 404, body: 'null', success: false },
        { name: 'unauthorized', status: 401, body: {}, success: false },
        { name: 'permission denied', status: 403, body: { code: 50013 }, success: false },
        { name: 'wrong HTTP status with Unknown Message code', status: 500, body: { code: 10008 }, success: false },
        { name: 'rate limited', status: 429, body: { retry_after: 1 }, success: false },
        { name: 'network error', success: false },
    ];
    for (const scenario of cases) {
        it(`${scenario.name}: ${scenario.success ? 'clears' : 'preserves'} the database record`, async t => {
            let removed = false;
            let purged = 0;
            t.mock.method(globalThis, 'fetch', async (url, options) => {
                assert.equal(url, 'https://discord.com/api/v10/channels/channel/messages/message');
                assert.equal(options.method, 'DELETE');
                if (!scenario.status) throw new Error('network unavailable');
                const body = scenario.body === null ? null : typeof scenario.body === 'string' ? scenario.body : JSON.stringify(scenario.body);
                return new Response(body, { status: scenario.status });
            });
            const route = await loadFunction('functions/api/manage/delete/[[path]].js', {
                getDatabase: () => ({
                    async getWithMetadata() { return { value: '', metadata: { Channel: 'Discord', DiscordMessageId: 'message', DiscordChannelId: 'channel', DiscordBotToken: 'token' } }; },
                    async delete() { removed = true; },
                }),
                hydrateFileCredentials: async (env, metadata) => metadata,
                DiscordAPI,
                purgeCFCache: async () => { purged++; },
                purgeRandomFileListCache: async () => { purged++; },
                purgePublicFileListCache: async () => { purged++; },
            });
            const result = await route.deleteFile({}, 'photo.png', 'https://img.example/file/photo.png', new URL('https://img.example'));
            assert.equal(result, scenario.success);
            assert.equal(removed, scenario.success);
            assert.equal(purged, scenario.success ? 3 : 0);
        });
    }
});
