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
const mf = new Miniflare({
    script: await readFile(artifact, 'utf8'), modules: true, compatibilityDate: '2024-12-01',
    host: '127.0.0.1', cf: false, kvNamespaces: ['img_url'], r2Buckets: ['img_r2'],
    serviceBindings: { ASSETS: () => new Response(page, { headers: { 'Content-Type': 'text/html' } }) },
    outboundService: req => {
        if (new URL(req.url).hostname === 'api.telegram.org') {
            outgoing.push({ url: new URL(req.url), headers: new Headers(req.headers) });
            if (req.url.includes('/getFile?')) return Response.json({ ok:true, result:{ file_path:'test.png' } });
            return new Response('x', {headers:{'Set-Cookie':'injected=1', Refresh:'0; url=/secret'}});
        }
        return Response.json({});
    },
    bindings:{TG_BOT_TOKEN:'123:fixture',TG_CHAT_ID:'chat'},
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
} finally { await mf.dispose(); }
