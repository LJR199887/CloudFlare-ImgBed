import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadFunction } from './helpers/loadFunction.js';
import { stripSensitiveMetadata } from '../functions/utils/metadata/metadataSecurity.js';

const metadata = { TimeStamp: Date.now(), FileName: 'photo.png', S3SecretAccessKey: 'secret', TgBotToken: 'token' };

describe('management list credential redaction', () => {
    for (const fallback of [false, true]) {
        it(`redacts legacy credentials in ${fallback ? 'database fallback' : 'index'} responses`, async () => {
            const route = await loadFunction('functions/api/manage/list.js', {
                stripSensitiveMetadata,
                readIndex: async (_context, options) => fallback && !options.sourceFiles
                    ? { success: false }
                    : { success: true, files: options.sourceFiles || [{ id: 'photo.png', metadata }], directories: [], totalCount: 1, directFileCount: 1, directFolderCount: 0, returnedCount: 1 },
                getDatabase: () => ({
                    async list() { return { keys: [{ name: 'photo.png', metadata }] }; },
                }),
            });
            const request = new Request('https://img.example/api/manage/list');
            const response = await route.onRequest({ request, env: {}, waitUntil() {} });
            assert.equal(response.status, 200, await response.clone().text());
            const body = await response.json();
            assert.equal(body.files[0].metadata.S3SecretAccessKey, undefined);
            assert.equal(body.files[0].metadata.TgBotToken, undefined);
            assert.equal(body.files[0].metadata.FileName, 'photo.png');
        });
    }
});
