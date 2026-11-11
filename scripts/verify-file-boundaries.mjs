// Exercise the compiled Pages Worker over HTTP rather than importing handlers
// with mocks. Temporary KV/R2, stub provider egress, optional isolated browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';

const [artifact, browser] = process.argv.slice(2);
if (!artifact) throw new Error('Usage: node scripts/verify-file-boundaries.mjs <compiled index.js> [Edge/Chromium executable]');
let page = '';
const outgoing = [];
const hfCommits = [];
const mf = new Miniflare({
    script: await readFile(artifact, 'utf8'), modules: true, compatibilityDate: '2024-12-01',
    host: '127.0.0.1', cf: false, kvNamespaces: ['img_url'], r2Buckets: ['img_r2'],
    serviceBindings: { ASSETS: () => new Response(page, { headers: { 'Content-Type': 'text/html' } }) },
    outboundService: async req => {
        if (new URL(req.url).hostname === 'api.telegram.org') {
            outgoing.push({ url: new URL(req.url), headers: new Headers(req.headers) });
            if (req.url.includes('/getFile?')) return Response.json({ ok:true, result:{ file_path:'test.png' } });
            return new Response('x', {headers:{'Set-Cookie':'injected=1', Refresh:'0; url=/secret'}});
        }
        if (new URL(req.url).hostname === 'huggingface.co') {
            const path = new URL(req.url).pathname;
            if (path.endsWith('/preupload/main')) return Response.json({ files: [{ uploadMode: 'lfs' }] });
            if (path.endsWith('/objects/batch')) return Response.json({ objects: [{}] });
            if (path.endsWith('/commit/main')) {
                hfCommits.push(JSON.parse((await req.text()).split('\n')[1]).value);
                return Response.json({ commitOid: 'fixture' });
            }
        }
        return Response.json({});
    },
    bindings:{TG_BOT_TOKEN:'123:fixture',TG_CHAT_ID:'chat',HF_TOKEN:'fixture',HF_REPO:'owner/repo',HF_PRIVATE:'true'},
});
try {
    const origin = await mf.ready;
    const kv = await mf.getKVNamespace('img_url');
    const req = (path, options) => fetch(new URL(path, origin), options);
    async function upload(name, bytes, type = 'application/octet-stream') {
        const form = new FormData();
        form.set('file', new File([bytes], name, {type}));
        const response = await req('/upload?uploadChannel=cfr2&autoRetry=false',{method:'POST',body:form});
        assert.equal(response.status,200,await response.clone().text());
        return (await response.json())[0].src;
    }
    const html = await upload('probe.html','<script>parent.payloadExecuted=true</script>');
    const js = await upload('probe.js','window.payloadExecuted=true');
    const ambiguous = [];
    for (const type of ['text/plain; a=b, text/javascript', 'image/png; a=b, application/javascript', 'text/plain; charset=UTF-8, text/javascript']) {
        const path = await upload('ambiguous.txt', 'window.payloadExecuted=true', type);
        ambiguous.push(path);
        const response = await req(path);
        assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
        assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
        await response.arrayBuffer();
    }
    const png = await upload('probe.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
    for (const options of [{}, {method:'HEAD'}, {headers:{Range:'bytes=0-1'}}]) {
        const response = await req(html,options);
        assert.equal(response.status, options.headers ? 206 : 200);
        assert.equal(response.headers.get('Content-Type'),'application/octet-stream');
        assert.match(response.headers.get('Content-Disposition'),/^attachment;/);
        assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
        assert.match(response.headers.get('Content-Security-Policy'),/sandbox/);
        await response.arrayBuffer();
    }
    assert.equal((await req(png)).headers.get('Content-Type'),'image/png');
    await kv.put('via-bot','',{metadata:{ Channel:'TelegramNew',TgFileId:'file',TgBotId:'123',TgChatId:'chat',FileType:'image/png' }});
    const tg = await req('/file/via-bot',{headers:{Cookie:'admin_session=fixture',Authorization:'Bearer fixture','X-Api-Key':'fixture',Range:'bytes=0-0'}});
    assert.equal(tg.status,200); assert.equal(outgoing.length,2);
    for (const {headers} of outgoing) for (const key of ['cookie','authorization','x-api-key']) assert.ok(!headers.has(key));
    assert.equal(outgoing[1].headers.get('range'),'bytes=0-0'); assert.ok(!tg.headers.has('set-cookie') && !tg.headers.has('refresh'));
    console.log('PASS: compiled Worker upload, GET/HEAD/Range, raster preview and outbound/response header isolation');

    // Exercise the actual compiled middleware/router, not only its helper.
    await kv.put('manage@sysConfig@security', JSON.stringify({
        auth: { admin: { adminUsername: 'fixture-admin', adminPassword: 'fixture-only' } },
        apiTokens: { tokens: {
            read: { token: 'read-fixture', permissions: ['list'] },
            manage: { token: 'manage-fixture', permissions: ['manage'] },
            upload: { token: 'upload-fixture', permissions: ['upload'] },
        } },
    }));
    await kv.put('list/probe.png', '', { metadata: { Channel: 'CloudflareR2', FileName: 'original' } });
    const patch = token => req('/api/manage/metadata/list/probe.png', {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ FileName: 'changed' }),
    });
    assert.equal((await patch('read-fixture')).status, 401);
    assert.equal((await kv.getWithMetadata('list/probe.png')).metadata.FileName, 'original');
    for (const action of ['rebuild', 'merge-operations', 'delete-operations']) {
        assert.equal((await req(`/api/manage/list?action=${action}`, { headers: { Authorization: 'Bearer read-fixture' } })).status, 401);
    }
    assert.equal((await patch('manage-fixture')).status, 200);
    assert.equal((await kv.getWithMetadata('list/probe.png')).metadata.FileName, 'changed');
    console.log('PASS: compiled Worker rejects list-token metadata/index mutations and accepts manage-token control');

    const admin = { Authorization: 'Bearer manage-fixture' };
    const invalidAuth = { auth: { admin: { adminUsername: false } } };
    const invalidUpdate = await req('/api/manage/sysConfig/security', { method: 'POST', headers: admin, body: JSON.stringify(invalidAuth) });
    assert.equal(invalidUpdate.status, 400);
    const invalidRestore = await req('/api/manage/batch/restore/chunk', { method: 'POST', headers: admin, body: JSON.stringify({
        type: 'settings', data: { 'sysConfig@security': invalidAuth },
    }) });
    assert.equal(invalidRestore.status, 200);
    assert.equal((await invalidRestore.json()).failedCount, 1);
    assert.equal((await req('/api/manage/sysConfig/security', { headers: admin })).status, 200);
    console.log('PASS: compiled Worker rejects corrupt security writes and preserves authentication');

    const restoredCookie = { Cookie: 'admin_session=restored-fixture' };
    const securityWithCookie = () => req('/api/manage/sysConfig/security', { headers: restoredCookie });
    assert.equal((await securityWithCookie()).status, 401);
    const runtimeRestore = await req('/api/manage/batch/restore/chunk', { method:'POST', headers:admin, body:JSON.stringify({
        type:'settings', data:{ 'session@restored-fixture': { authType:'admin', expiresAt:Date.now()+3600000 } },
    }) });
    assert.equal((await runtimeRestore.json()).failedCount,1);
    assert.equal(await kv.get('manage@session@restored-fixture'),null);
    assert.equal((await securityWithCookie()).status,401);
    await kv.put('manage@session@restored-fixture',JSON.stringify({authType:'admin'}));
    assert.equal((await securityWithCookie()).status,401);
    console.log('PASS: compiled Worker rejects session restore and missing session expiration');

    const first = await upload('concurrent-a.txt', 'first', 'text/plain');
    const second = await upload('concurrent-b.txt', 'second', 'text/plain');
    const rename = path => req(path.replace('/file/', '/api/manage/rename/'), {
        method: 'POST', headers: admin, body: JSON.stringify({ newFileId: 'contended.txt' }),
    });
    const r2 = await mf.getR2Bucket('img_r2');
    const lockId = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('contended.txt'))).toString('hex');
    const claim = `manage@file-mutation/lock/${lockId}`;
    await r2.put(claim, 'a different writer');
    assert.equal((await rename(first)).status, 409);
    assert.equal(await (await r2.get(claim)).text(), 'a different writer');
    await r2.delete(claim);
    const outcomes = await Promise.all([rename(first), rename(second)]);
    assert.deepEqual(outcomes.map(response => response.status).sort(), [200,409]);
    const won = outcomes[0].status === 200;
    assert.equal(await (await req('/file/contended.txt')).text(), won ? 'first' : 'second');
    assert.equal(await (await req(won ? second : first)).text(), won ? 'second' : 'first');
    console.log('PASS: compiled Worker honors R2 claims and preserves the losing source on collision');

    const originalMetadata = { Channel: 'CloudflareR2', FileName: '', FileType: 'text/plain' };
    await kv.put('near-limit.txt', '', { metadata: originalMetadata });
    const changeName = FileName => req('/api/manage/metadata/near-limit.txt', { method:'PATCH',headers:admin,body:JSON.stringify({FileName}) });
    const rejectedName = 'x'.repeat(1010 - Buffer.byteLength(JSON.stringify(originalMetadata)));
    assert.equal((await changeName(rejectedName)).status,413);
    assert.equal((await changeName('short.txt')).status,200);
    assert.equal((await kv.getWithMetadata('near-limit.txt')).metadata.FileName,'short.txt');
    console.log('PASS: rejected KV metadata does not poison the file generation');

    for (const action of ['move','rename']) {
        const source = `preflight-${action}.txt`;
        const folder = 'x'.repeat(100);
        const target = `${folder}/${source}`;
        await kv.put(source,'',{metadata:{Channel:'CloudflareR2',FileName:'x'.repeat(860)+'.txt',FileType:'text/plain',Directory:''}});
        await r2.put(source,'original bytes');
        const relocate = () => req(`/api/manage/${action}/${source}?dist=${folder}`,{
            method:'POST',headers:admin,body:JSON.stringify({newFileId:target}),
        });
        assert.notEqual((await relocate()).status,200);
        assert.equal(await kv.get(target),null);
        assert.equal(await r2.head(target),null,'validation must run before copying the target');
        assert.equal(await (await r2.get(source)).text(),'original bytes');
        assert.equal((await req(`/api/manage/metadata/${source}`,{
            method:'PATCH',headers:admin,body:JSON.stringify({FileName:'short.txt'}),
        })).status,200);
        assert.equal((await relocate()).status,200);
        assert.equal(await (await r2.get(target)).text(),'original bytes');
        assert.equal(await r2.head(source),null);
    }
    console.log('PASS: move and rename preflight prevents orphaned R2 targets and permits a corrected retry');

    const hfPost = (route, body) => req(`/upload/huggingface/${route}`, {
        method:'POST',headers:{Authorization:'Bearer upload-fixture'},body:JSON.stringify(body),
    });
    const input = {fileName:'new.bin',fileSize:3,sha256:'a'.repeat(64),fileSample:'YWJj',uploadNameType:'origin'};
    assert.equal((await hfPost('commitUpload',{...input,fullId:'fresh.bin',filePath:'published.bin'})).status,409);
    const grantResponse = await hfPost('getUploadUrl', input);
    assert.equal(grantResponse.status,200,await grantResponse.clone().text());
    const {fullId,filePath,channelName} = await grantResponse.json();
    const commitBody = {...input,fullId,filePath,channelName};
    for (const change of [{fullId:'different.bin'},{sha256:'b'.repeat(64)},{fileSize:4},{filePath:'published.bin'},{channelName:'other'}]) {
        assert.equal((await hfPost('commitUpload',{...commitBody,...change})).status,409);
    }
    assert.equal(hfCommits.length,0);
    const committed=await hfPost('commitUpload',commitBody);
    assert.equal(committed.status,200,await committed.clone().text());
    assert.equal(hfCommits.length,1);
    assert.equal(hfCommits[0].path,filePath);
    assert.equal((await req(`/api/manage/rename/${fullId}`,{
        method:'POST',headers:admin,body:JSON.stringify({newFileId:'renamed-hf.bin'}),
    })).status,200);
    assert.equal((await hfPost('commitUpload',commitBody)).status,409);
    assert.equal(hfCommits.length,1);
    assert.equal((await req('/file/..%2Foutside.txt')).status,400);
    console.log('PASS: direct upload grants reject overwrite, mismatched parameters and replay after rename');

    if (browser) {
        // If either an HTML document or an uploaded JS subresource executes,
        // it sets the flag. Also require an actual PNG decode as a control.
        page = `<!doctype html><body><output>pending</output><script>window.payloadExecuted=false;</script>
        <script src="${js}"></script>${ambiguous.map(path => `<script src="${path}"></script>`).join('')}<iframe src="${html}"></iframe><img id="p" src="${png}">
        <script>window.onload=()=>document.querySelector('output').textContent=
        (!window.payloadExecuted && document.getElementById('p').naturalWidth===1) ? 'PASS' : 'FAIL';</script>`;
        const tempRoot = await realpath(tmpdir());
        const profile = await mkdtemp(join(tempRoot,'imgbed-isolated-browser-'));
        try {
            const child = spawn(browser, [
                '--headless','--disable-gpu','--no-first-run','--disable-background-mode','--disable-extensions','--disable-background-networking',
                '--disable-component-update',`--user-data-dir=${profile}`,'--dump-dom','--virtual-time-budget=5000',
                new URL('/review-browser.html',origin).href,
            ], { windowsHide:true, stdio:['ignore','pipe','ignore'] });
            await new Promise((resolve,reject) => {
                let dom = '';
                const deadline = setTimeout(() => child.kill(),45000);
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', chunk => {
                    dom += chunk;
                    // Some desktop browsers keep the headless process alive
                    // after dumping the DOM. Stop only our dedicated child.
                    if (dom.includes('</html>')) child.kill();
                });
                child.once('error', error => { clearTimeout(deadline); reject(error); });
                child.once('close', () => {
                    clearTimeout(deadline);
                    if (/<output>PASS<\/output>/.test(dom)) resolve();
                    else reject(new Error('Browser did not report a successful probe'));
                });
            });
            console.log('PASS: browser blocked HTML, JS and ambiguous MIME execution while rendering PNG');
        } finally {
            const owned = await realpath(profile);
            if (dirname(owned) !== tempRoot || !basename(owned).startsWith('imgbed-isolated-browser-')) throw new Error('Unexpected browser profile path');
            await rm(owned,{recursive:true,force:true,maxRetries:10,retryDelay:200});
        }
    }
    // A corrupt persisted security configuration must not enable anonymous
    // management or let a previously valid token bypass the unavailable policy.
    await kv.put('manage@sysConfig@security', '{');
    for (const headers of [{}, { Authorization: 'Bearer manage-fixture' }]) {
        const response = await req('/api/manage/metadata/list/probe.png', {
            method: 'PATCH', headers, body: JSON.stringify({ FileName: 'unauthorized-change' }),
        });
        assert.equal(response.status, 401);
        assert.equal((await kv.getWithMetadata('list/probe.png')).metadata.FileName, 'changed');
    }
    console.log('PASS: compiled Worker fails closed on corrupt security settings');
} finally { await mf.dispose(); }

// Check the actual routes, D1 result metadata, and storage effects of a
// multi-request folder operation and a credential restore in workerd.
const d1Worker = new Miniflare({
    script: await readFile(artifact, 'utf8'), modules: true, compatibilityDate: '2024-12-01',
    host: '127.0.0.1', cf: false, d1Databases: ['img_d1'], r2Buckets: ['img_r2'],
    serviceBindings: { ASSETS: () => new Response(null, { status: 404 }) },
    bindings: { BASIC_USER: 'fixture-admin', BASIC_PASS: 'before' },
});
try {
    const origin = await d1Worker.ready;
    const db = await d1Worker.getD1Database('img_d1');
    const r2 = await d1Worker.getR2Bucket('img_r2');
    const schema = await readFile(new URL('../database/init.sql', import.meta.url), 'utf8');
    const ddl = schema.replace(/^\s*--.*$/gm, '').split(/;\s*(?=CREATE|$)/i).filter(sql => sql.trim());
    await db.batch(ddl.map(sql => db.prepare(sql)));
    const req = (path, options) => fetch(new URL(path, origin), options);
    const login = password => req('/api/auth/adminLogin', { method: 'POST', body: JSON.stringify({ username: 'fixture-admin', password }) });
    const oldLogin = await login('before');
    assert.equal(oldLogin.status, 200, await oldLogin.clone().text());
    const headers = { Cookie: oldLogin.headers.get('set-cookie').split(';')[0] };
    const ids = ['scope/a.txt', 'scope/b.txt', 'scope/sub/雪.txt', 'scope2/keep.txt'];
    for (const id of ids) {
        await r2.put(id, id);
        await db.prepare('INSERT INTO files (id, value, metadata) VALUES (?, ?, ?)')
            .bind(id, '', JSON.stringify({ Channel: 'CloudflareR2', FileName: id.split('/').at(-1) })).run();
    }
    const move = '/api/manage/move/scope?folder=true&dist=dest';
    assert.equal((await req(move, { headers })).status, 413);
    const first = await req(move + '&paged=1', { headers });
    assert.equal(first.status, 200, await first.clone().text());
    const page = await first.json();
    assert.equal(page.processed.length, 2);
    const second = await req(move + `&paged=1&cursor=${encodeURIComponent(page.nextCursor)}`, { headers });
    assert.equal(second.status, 200, await second.clone().text());
    assert.deepEqual((await second.json()).processed, [{ fileId: ids[2], newFileId: 'dest/' + ids[2] }]);
    for (const id of ids.slice(0, -1)) {
        assert.equal(await r2.head(id), null);
        assert.equal(await (await r2.get('dest/' + id)).text(), id);
    }
    assert.ok(await r2.head(ids.at(-1)));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM file_mutation_claims').first()).n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM index_operations').first()).n, 2);
    console.log('PASS: compiled D1 Worker paginates folder moves and releases all claims');

    const security = '/api/manage/sysConfig/security';
    const save = await req(security, { method: 'POST', headers, body: JSON.stringify({ access: { whiteListMode: false } }) });
    assert.equal(save.status, 200, await save.clone().text());
    const update = await req(security, { method: 'POST', headers, body: JSON.stringify({ access: { whiteListMode: true } }) });
    assert.equal(update.status, 200, await update.clone().text());
    // Export real multipart rows, then import with the exact processor and
    // completion code loaded by the published management page.
    const chunkMetadata = { Channel: 'TelegramNew', ChannelName: 'test', TgBotId: '123', TgChatId: 'test-chat',
        TimeStamp: 1, IsChunked: true, TotalChunks: 1, FileSizeBytes: 1 };
    const manifest = JSON.stringify([{ index: 0, fileId: 'telegram-fixture', size: 1 }]);
    const restoredIds = Array.from({ length: 52 }, (_, i) => `restore-${String(i).padStart(2,'0')}.bin`);
    await db.batch(restoredIds.map(id => db.prepare('INSERT INTO files (id, value, metadata, timestamp) VALUES (?, ?, ?, ?)')
        .bind(id, manifest, JSON.stringify(chunkMetadata), 1)));
    const backup = await req('/api/manage/batch/list?limit=1000&includeValue=true', { headers });
    assert.equal(backup.status, 200, await backup.clone().text());
    const { records } = await backup.json();
    assert.deepEqual(records.map(record => record.id), restoredIds);
    assert.ok(records.every(record => record.value === manifest));
    await db.prepare('DELETE FROM files WHERE id GLOB ?').bind('restore-*.bin').run();
    await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .bind('manage@index@meta', JSON.stringify({ lastUpdated: 1, totalCount: 0, chunkCount: 0, chunkSize: 500 })).run();

    const html = await readFile('frontend-dist/index.html', 'utf8');
    const runtime = await readFile('frontend-dist/js/' + html.match(/app\.[a-f0-9]{8}\.js/)[0], 'utf8');
    const frontend = await readFile('frontend-dist/js/381.' + runtime.match(/381:"([a-f0-9]{8})"/)[1] + '.js', 'utf8');
    const processorStart = frontend.indexOf('class cu{');
    const processorEnd = frontend.indexOf('var uu=cu;', processorStart);
    assert.ok(processorStart >= 0 && processorEnd > processorStart);
    const processorSource = frontend.slice(processorStart, processorEnd);
    class BatchOperationError extends Error { constructor(message, code) { super(message); this.code = code; } }
    const calls = [];
    const Processor = new Function('Pe', 'su', `${processorSource}; return cu;`)({ A: (path, options) => {
        calls.push(JSON.parse(options.body).type);
        return req(path, { ...options, headers: { ...options.headers, ...headers } });
    } }, BatchOperationError);
    const result = await new Processor().restore({ data: {
        files: Object.fromEntries(records.map(({ id, ...file }) => [id, file])),
        settings: {
            'sysConfig@upload': { telegram: { channels: [{ name: 'test', botToken: '123:fixture', chatId: 'test-chat' }] } },
            'sysConfig@security': { auth: { admin: { adminUsername: 'fixture-admin', adminPassword: 'after' } } },
        },
    } });
    assert.equal(result.restoredFiles, restoredIds.length);
    assert.equal(result.failedFiles + result.failedSettings, 0);
    assert.equal(result.reauthenticationRequired, true);
    assert.equal(calls.at(-1), 'settings');
    const completion = frontend.match(/n\.failedFiles\|\|n\.failedSettings\?this\.\$message\.warning\(.+?this\.\$router\.replace\(\{name:"adminLogin"\}\)/)?.[0];
    assert.ok(completion, 'published restore UI must navigate to login, not request a rebuild');
    assert.ok(!frontend.includes('await new Promise(t=>setTimeout(t,500)),await this.rebuildIndex()'));
    let redirected;
    await new Function(`return async function(n){${completion}}`)().call({
        $message: { success() {}, warning() { assert.fail('unexpected partial-restore warning'); } },
        $t: key => key, $router: { async replace(target) { redirected = target.name; } },
    }, result);
    assert.equal(redirected, 'adminLogin');
    assert.equal((await req(security, { headers })).status, 401);
    assert.equal((await login('before')).status, 401);
    const fresh = await login('after');
    assert.equal(fresh.status, 200, await fresh.clone().text());
    const freshHeaders = { Cookie: fresh.headers.get('set-cookie').split(';')[0] };
    const config = await req(security, { headers: freshHeaders });
    assert.equal(config.status, 200);
    assert.equal((await config.json()).sessionEpochs, undefined);
    const list = await req('/api/manage/list?count=100', { headers: freshHeaders });
    assert.equal(list.status, 200, await list.clone().text());
    const listed = await list.json();
    assert.equal(listed.isIndexedResponse, true);
    assert.deepEqual(listed.files.map(file => file.name).filter(id => id.startsWith('restore-')).sort(), restoredIds);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM index_operations').first()).n, 0);
    console.log('PASS: shipped restore workflow exports and imports multipart files, rotates authentication, and lists restored files after login');
} finally { await d1Worker.dispose(); }
