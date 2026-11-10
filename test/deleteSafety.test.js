import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadFunction } from './helpers/loadFunction.js';

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
