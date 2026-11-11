// Exercise one shared storage namespace from two distinct Worker isolates.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

const claims = await readFile(new URL('../functions/utils/fileMutation.js', import.meta.url), 'utf8');
const fileIds = await readFile(new URL('../functions/utils/fileId.js', import.meta.url), 'utf8');
const probe = `import { withFileMutation } from './claims.js';
export default { async fetch(request, env) {
    try {
        return await withFileMutation(env, ['shared.png'], async () => {
            if (new URL(request.url).pathname === '/hold') await env.LATCH.fetch('https://latch.test/');
            return new Response('acquired');
        });
    } catch (error) {
        return new Response(error.message, { status: error.status || 500 });
    }
} };`;
for (const [label, bindings] of [
    ['D1', { d1Databases: { img_d1: 'shared-d1' } }],
    ['R2', { r2Buckets: { img_r2: 'shared-r2' } }],
]) {
    let entered, release;
    const holding = new Promise(resolve => { entered = resolve; });
    const resumed = new Promise(resolve => { release = resolve; });
    const mf = new Miniflare({ workers: ['owner', 'contender'].map(name => ({
        name, compatibilityDate: '2024-12-01',
        modules: [
            { type: 'ESModule', path: 'probe.js', contents: probe },
            { type: 'ESModule', path: 'claims.js', contents: claims },
            { type: 'ESModule', path: 'fileId.js', contents: fileIds },
        ],
        ...bindings,
        serviceBindings: { LATCH: async () => { entered(); await resumed; return new Response(null); } },
    })) });
    try {
        const owner = await mf.getWorker('owner');
        const contender = await mf.getWorker('contender');
        const pending = owner.fetch('https://img.test/hold');
        try {
            const unexpected = await Promise.race([holding, pending]);
            if (unexpected) assert.fail(`${label} did not acquire: ${unexpected.status} ${await unexpected.text()}`);
            assert.equal((await contender.fetch('https://img.test/')).status, 409);
        } finally { release(); }
        assert.equal((await pending).status, 200);
        assert.equal((await contender.fetch('https://img.test/')).status, 200);
        console.log(`PASS: ${label} claims exclude competing Worker isolates and release cleanly`);
    } finally { await mf.dispose(); }
}
