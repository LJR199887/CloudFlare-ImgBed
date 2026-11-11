import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { assertRestoredFileSafe } from '../functions/utils/metadata/writeSafety.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { loadFunction } from './helpers/loadFunction.js';
import { databaseFixture } from './helpers/databaseFixture.js';

class BatchOperationError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}

async function processorClass(bundled, fetchWithAuth) {
    if (!bundled) {
        const source = (await readFile('frontend-patches/restoreProcessor.js', 'utf8'))
            .replace(/^import .*;\r?\n/gm, '').replace('export default RestoreProcessor;', 'return RestoreProcessor;');
        return new Function('fetchWithAuth', 'BatchOperationError', source)(fetchWithAuth, BatchOperationError);
    }
    // Follow the exact index -> runtime -> lazy chunk chain shipped to browsers.
    const index = await readFile('frontend-dist/index.html', 'utf8');
    const runtimeName = index.match(/app\.[a-f0-9]{8}\.js/)[0];
    const runtime = await readFile(`frontend-dist/js/${runtimeName}`, 'utf8');
    const chunkHash = runtime.match(/381:"([a-f0-9]{8})"/)[1];
    const code = await readFile(`frontend-dist/js/381.${chunkHash}.js`, 'utf8');
    const start = code.indexOf('class cu{'), end = code.indexOf('var uu=cu;', start);
    assert.ok(start >= 0 && end > start);
    const mapName = code.match(/sourceMappingURL=(.*)/)[1].trim();
    const map = JSON.parse(await readFile(`frontend-dist/js/${mapName}`, 'utf8'));
    assert.equal(map.file, `js/381.${chunkHash}.js`);
    return new Function('Pe', 'su', `${code.slice(start, end)}; return cu;`)({ A: fetchWithAuth }, BatchOperationError);
}

describe('shipped frontend restore workflow', () => {
    for (const bundled of [false, true]) {
        for (const backend of ['KV', 'D1']) {
            it(`${bundled ? 'bundle' : 'source'}/${backend}: restores channels, files, then authentication in a single pass`, async t => {
                const f = databaseFixture(t, backend);
                const route = await loadFunction('functions/api/manage/batch/restore/chunk.js', { getDatabase: createDatabaseAdapter, assertRestoredFileSafe });
                const calls = [];
                const Processor = await processorClass(bundled, async (url, options) => {
                    assert.equal(url, '/api/manage/batch/restore/chunk');
                    const body = JSON.parse(options.body); calls.push([body.type, Object.keys(body.data)]);
                    return route.onRequestPost({ env: f.env, request: new Request(`https://img.example${url}`, options) });
                });
                const progress = [];
                const processor = new Processor({ chunkSize: 1, onProgress: p => progress.push(p) });
                const result = await processor.restore({ timestamp: 1, data: {
                    settings: {
                        'sysConfig@security': { auth: { admin: { adminPassword: 'dummy-password' } } },
                        'sysConfig@upload': { discord: { channels: [{ name: 'discord', channelId: 'chat', botToken: 'secret' }] } },
                    },
                    files: { 'file.png': { metadata: { Channel: 'Discord', ChannelName: 'discord', DiscordChannelId: 'chat', DiscordBotToken: 'secret' } } },
                } });
                assert.deepEqual(calls, [['settings', ['sysConfig@upload']], ['files', ['file.png']], ['settings', ['sysConfig@security']]]);
                assert.equal(result.failedFiles, 0); assert.equal(result.restoredFiles, 1); assert.equal(result.restoredSettings, 2);
                const saved = (await f.db.getWithMetadata('file.png')).metadata;
                assert.equal(saved.DiscordBotToken, undefined);
                assert.equal((await hydrateFileCredentials(f.env, saved)).DiscordBotToken, 'secret');
                const percentages = progress.filter(p => p.percentage != null).map(p => p.percentage);
                assert.deepEqual([...percentages].sort((a, b) => a - b), percentages);
                assert.equal(percentages.at(-1), 100);
            });
        }

        it(`${bundled ? 'bundle' : 'source'}: channel-setting failure stops before importing files`, async () => {
            const calls = [];
            const Processor = await processorClass(bundled, async (url, options) => {
                calls.push(JSON.parse(options.body).type);
                return Response.json({ success: true, restoredCount: 0, failedCount: 1 });
            });
            await assert.rejects(new Processor().restore({ data: {
                settings: { 'manage@sysConfig@upload': {} }, files: { 'file.png': { metadata: {} } },
            } }), { code: 'SETTINGS_RESTORE_FAILED' });
            assert.deepEqual(calls, ['settings']);
        });

        it(`${bundled ? 'bundle' : 'source'}: supports empty and file-only backups without NaN progress`, async () => {
            const progress = [];
            const Processor = await processorClass(bundled, async () => Response.json({ success: true, restoredCount: 0, failedCount: 1 }));
            const processor = new Processor({ onProgress: p => progress.push(p) });
            assert.equal((await processor.restore({ data: {} })).failedFiles, 0);
            assert.equal((await processor.restore({ data: { files: { 'bad.png': { metadata: {} } } } })).failedFiles, 1);
            assert.ok(progress.every(p => p.percentage == null || (Number.isFinite(p.percentage) && p.percentage <= 100)));
        });

        it(`${bundled ? 'bundle' : 'source'}: default restore batches obey the D1 file limit`, async t => {
            const { env } = databaseFixture(t, 'D1');
            const route = await loadFunction('functions/api/manage/batch/restore/chunk.js', { getDatabase: createDatabaseAdapter, assertRestoredFileSafe });
            const sizes = [];
            const Processor = await processorClass(bundled, async (url, options) => {
                sizes.push(Object.keys(JSON.parse(options.body).data).length);
                return route.onRequestPost({ env, request: new Request(`https://img.example${url}`, options) });
            });
            const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, { metadata: { Channel: 'CloudflareR2' } }]));
            const result = await new Processor().restore({ data: { files } });
            assert.deepEqual(sizes, [5,5,2]);
            assert.equal(result.restoredFiles, 12);
            assert.equal(result.failedFiles, 0);
        });
    }

    it('keeps all HTML local JS references present after hash updates', async () => {
        const index = await readFile('frontend-dist/index.html', 'utf8');
        const names = await readdir('frontend-dist/js');
        for (const match of index.matchAll(/(?:src|href)="\/?js\/([^"?]+\.js)/g)) assert.ok(names.includes(match[1]), match[1]);
    });
});
