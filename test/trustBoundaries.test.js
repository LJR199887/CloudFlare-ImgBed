import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as files from '../functions/file/fileTools.js';
import { applyDownloadPolicy } from '../functions/utils/downloadPolicy.js';
import { databaseFixture } from './helpers/databaseFixture.js';
import { loadFunction } from './helpers/loadFunction.js';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { resolveWebDAVConfig } from '../functions/utils/webdavConfig.js';
import { prepareMetadataForStorage, getWebDAVAccountId } from '../functions/utils/metadata/webdavIdentity.js';
import { stripUrlUserinfo } from '../functions/utils/metadata/metadataSecurity.js';
import { TelegramAPI } from '../functions/utils/storage/telegramAPI.js';
import { DiscordAPI } from '../functions/utils/storage/discordAPI.js';
import { HuggingFaceAPI } from '../functions/utils/storage/huggingfaceAPI.js';
import { WebDAVAPI } from '../functions/utils/storage/webdavAPI.js';
import { onRequestGet as list } from '../functions/api/manage/batch/list.js';
import { onRequestPost as restore } from '../functions/api/manage/batch/restore/chunk.js';
import { publicFileMetadata } from '../functions/utils/metadata/metadataSecurity.js';
import { fetchPublicHop, isPublicAddress } from '../deploy/server/publicDownload.js';
import { fetchFileForDisplay, fetchImportedFile } from '../functions/utils/downloadPolicy.js';

const origin = 'https://img.test';
const getFiles = env => list({ env, request: new Request(origin + '/list?includeValue=true') });
const putFiles = async (env, data) => (await restore({ env, request: new Request(origin + '/restore', {
    method: 'POST', body: JSON.stringify({ type: 'files', data }),
}) })).json();
const getRoute = () => loadFunction('functions/file/[[path]].js', {
    ...files, getDatabase: createDatabaseAdapter, hydrateFileCredentials, resolveWebDAVConfig,
    stripUrlUserinfo, fetchSecurityConfig: async () => ({ access: {} }), TelegramAPI, DiscordAPI, HuggingFaceAPI, WebDAVAPI,
});
function safeAttachment(response) {
    assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
    assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
}

describe('browser and provider trust boundaries', () => {
    for (const type of ['text/html', 'IMAGE/SVG+XML; charset=UTF-8', 'application/xhtml+xml', 'text/javascript',
        'application/javascript', 'text/css', 'application/xml', 'application/x-unknown', undefined]) {
        it(`isolates ${type} even if explicitly supplied or returned by a CDN`, () => {
            const h = new Headers(); files.setCommonHeaders(h, 'payload', type);
            safeAttachment(new Response('', { headers: h })); safeAttachment(files.handleHeadRequest(h));
        });
    }
    it('preserves benign image, video and text previews', () => {
        for (const type of ['image/png', 'audio/mpeg', 'video/mp4', 'text/plain; charset=UTF-8']) {
            const h = new Headers(); applyDownloadPolicy(h, type, 'safe');
            assert.match(h.get('Content-Disposition'), /^inline;/); assert.equal(h.get('Content-Type'), type);
        }
    });
    it('handles single Telegram downloads without passing credentials in either direction', async t => {
        const { env, seed } = databaseFixture(t);
        env.TG_BOT_TOKEN = '123:token'; env.TG_CHAT_ID = 'chat'; env.TG_PROXY_URL = 'proxy.test';
        seed('p', '', { Channel: 'TelegramNew', TgBotId: '123', TgFileId: 'id', TgChatId: 'chat', FileType: 'text/html' });
        const calls = [];
        t.mock.method(globalThis, 'fetch', async (url, options) => {
            calls.push({ url, h: new Headers(options.headers) });
            return url.includes('/getFile?') ? Response.json({ ok: true, result: { file_path: 'p' } })
                : new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/2', 'Set-Cookie': 'bad=1', Refresh: '0;url=/admin', Link: '</bad>; rel=preload' } });
        });
        const route = await getRoute();
        const request = new Request(origin + '/file/p', { headers: { Cookie: 'admin_session=probe', Authorization: 'Bearer dummy',
            'Proxy-Authorization': 'dummy', Referer: origin, 'X-Api-Key': 'private', Range: 'bytes=0-0', 'If-Range': '"x"' } });
        const response = await route.onRequest({ env, params: { path: 'p' }, request });
        assert.equal(response.status, 206); safeAttachment(response);
        assert.equal(calls.length, 2);
        for (const { h } of calls) for (const key of ['Cookie','Authorization','Proxy-Authorization','Referer','X-Api-Key']) assert.equal(h.has(key), false);
        assert.equal(calls[1].h.get('range'), 'bytes=0-0'); assert.equal(calls[1].h.get('if-range'), '"x"');
        for (const key of ['Set-Cookie', 'Refresh', 'Link']) assert.equal(response.headers.has(key), false);
        const post = await route.onRequest({ env, params: { path: 'p' }, request: new Request(request.url, { method: 'POST', body: 'private' }) });
        assert.equal(post.status, 405); assert.equal(calls.length, 2);
    });
    it('does not send a configured Hugging Face token to a stored URL or signed CDN', async t => {
        const { env, seed, db } = databaseFixture(t);
        await db.put('manage@sysConfig@upload', JSON.stringify({ huggingface: { channels: [{ name: 'hf', repo: 'org/private', token: 'hf-test', isPrivate: true }] } }));
        seed('f', '', { Channel: 'HuggingFace', ChannelName: 'hf', HfRepo: 'org/private', HfFilePath: 'dir/a #1.js', HfFileUrl: 'https://foreign.test/leak', FileType: 'text/javascript' });
        const calls = [];
        t.mock.method(globalThis, 'fetch', async (url, opts) => {
            calls.push([url, opts.headers.get('Authorization'),opts.headers.get('Range'),opts.redirect]);
            return calls.length === 1 ? Response.redirect('https://cdn.test/object?signature=ok', 302) : new Response('x', {status:206});
        });
        const response = await (await getRoute()).onRequest({ env, params:{path:'f'}, request:new Request(origin+'/file/f',{headers:{Range:'bytes=0-1'}}) });
        assert.equal(response.status,206); safeAttachment(response);
        assert.deepEqual(calls, [
            ['https://huggingface.co/datasets/org/private/resolve/main/dir/a%20%231.js','Bearer hf-test','bytes=0-1','manual'],
            ['https://cdn.test/object?signature=ok',null,'bytes=0-1','manual'],
        ]);
    });
    it('protects random byte responses even if an external file redirects to HTML',async t=>{
        const route=await loadFunction('functions/random/index.js',{
            fetchOthersConfig:async()=>({randomImageAPI:{enabled:true,allowedDir:''}}),
        },{caches:{default:{match:async()=>Response.json([{name:'test',FileType:'image/png'}])}}});
        t.mock.method(globalThis,'fetch',async()=>new Response('<script>test</script>',{headers:{'Content-Type':'text/html'}}));
        const response=await route.onRequest({env:{},request:new Request(origin+'/random?type=img')});
        assert.equal(response.status,200);safeAttachment(response);
    });
});

describe('WebDAV backup, index and directory safety', () => {
    it('keeps account bindings in backups but not public gallery metadata', () => {
        const m={WebDAVAccountId:'verifier',WebDAVRequiresPassword:true,FileName:'test'};
        assert.deepEqual(publicFileMetadata(m),{FileName:'test'});
        assert.equal(m.WebDAVAccountId,'verifier');
    });
    for (const backend of ['KV','D1']) {
        it(`${backend}: index listing never depends on a channel; full backup still fails closed`, async t => {
            const { env, seed } = databaseFixture(t,backend);
            seed('lost','',{Channel:'WebDAV',ChannelName:'gone',TimeStamp:1,WebDAVBaseUrl:'https://dav.test/root'});
            seed('ok','',{Channel:'CloudflareR2',TimeStamp:1,TgBotToken:'123:secret'});
            const response=await list({env,request:new Request(origin+'/list?includeValue=false')});
            assert.equal(response.status,200); const body=await response.json();
            assert.deepEqual(body.records.map(r=>r.id).sort(),['lost','ok']); assert.ok(!JSON.stringify(body).includes(':secret'));
            assert.equal((await getFiles(env)).status,500);
        });
        it(`${backend}: checks required password on export/restore, read and rotation`, async t => {
            const { env, db, seed }=databaseFixture(t,backend);
            const base='https://dav.test/root', existing={Channel:'CloudflareR2',TimeStamp:1};
            const set=password=>db.put('manage@sysConfig@upload',JSON.stringify({webdav:{channels:[{baseUrl:base,name:'dav',username:'a',password}]}}));
            const legacy={Channel:'WebDAV',ChannelName:'dav',TimeStamp:1,WebDAVFilePath:'p',WebDAVBaseUrl:'https://a:original@dav.test/root'};
            seed('p','',legacy);seed('copy','keep',existing);
            const {records}=await (await getFiles(env)).json();const record=records.find(r=>r.id==='p');
            assert.equal(record.metadata.WebDAVRequiresPassword,true); assert.ok(!JSON.stringify(record).includes('original'));
            await set('');const result=await putFiles(env,{copy:record});
            assert.equal(result.failedCount,1);assert.deepEqual((await db.getWithMetadata('copy')).metadata,existing);
            assert.equal(await resolveWebDAVConfig(env,record.metadata),null);
            await set('rotated');assert.equal((await putFiles(env,{copy:record})).restoredCount,1);
            assert.equal((await resolveWebDAVConfig(env,(await db.getWithMetadata('copy')).metadata)).password,'rotated');
        });
    }
    it('distinguishes intentionally passwordless Basic auth from an old hash-only backup',async t=>{
        const {env,db}=databaseFixture(t);const c={name:'dav',baseUrl:'https://dav.test/',username:'a',password:''};
        await db.put('manage@sysConfig@upload',JSON.stringify({webdav:{channels:[c]}}));
        const m={Channel:'WebDAV',ChannelName:c.name,WebDAVBaseUrl:c.baseUrl,WebDAVAccountId:await getWebDAVAccountId(c)};
        assert.equal((await putFiles(env,{old:{metadata:m}})).failedCount,1);
        const safe=await prepareMetadataForStorage({...m,WebDAVRequiresPassword:false});
        assert.equal((await putFiles(env,{clear:{metadata:safe}})).restoredCount,1);
    });
    it('refuses traversal before any remote WebDAV mutation',async t=>{
        let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:204})});
        const api=new WebDAVAPI({baseUrl:'https://dav.test/root',password:'token'});
        await assert.rejects(api.putFile('a/../../x','x'),/relative/);
        await assert.rejects(api.deleteFile('../x'),/relative/);
        assert.equal(calls,0);
    });
    it('escapes uploaded names in WebDAV HTML, attributes and PROPFIND XML', async t=>{
        const route=await loadFunction('functions/dav/[[path]].js',{fetchOthersConfig:async()=>({webDAV:{enabled:true,internalToken:'internal'}})});
        t.mock.method(globalThis,'fetch',async()=>Response.json({files:[{name:'<img onerror="x">&.png',metadata:{FileType:'</D:getcontenttype><bad/>'}}],directories:['<script>']}));
        for(const method of ['GET','PROPFIND']){
            const res=await route.onRequest({env:{},request:new Request(origin+'/dav/',{method})});
            const text=await res.text();assert.equal(res.status,method==='GET'?200:207);
            assert.ok(!text.includes('<img'));assert.ok(!text.includes('<script>'));assert.ok(!text.includes('<bad/>'));
            assert.ok(text.includes('&lt;img'));assert.ok(text.includes('%3Cimg'));
        }
    });
});

describe('remote clipboard and External-file downloads', () => {
    it('keeps a suggested filename but never republishes remote cookies, Refresh or HTML', async t => {
        const route=await loadFunction('functions/api/fetchRes.js',{dualAuthCheck:async()=>({authorized:true})});
        t.mock.method(globalThis,'fetch',async(_url, opts)=>{
            assert.equal(opts.redirect,'manual');
            return new Response('<script>bad()</script>',{headers:{
                'Content-Type':'text/html','Content-Disposition':"inline; filename*=UTF-8''%E7%94%BB.html",
                'Set-Cookie':'forged=1',Refresh:'0;url=/manage',
            }});
        });
        const call=url=>route.onRequest({env:{},request:new Request(origin+'/api/fetchRes',{
            method:'POST',body:JSON.stringify({url}),headers:{Cookie:'admin_session=fixture'},
        })});
        const res=await call('https://remote.test/dl?id=1');
        safeAttachment(res);assert.match(res.headers.get('Content-Disposition'),/%E7%94%BB.html/);
        assert.equal(res.headers.has('Set-Cookie'),false);assert.equal(res.headers.has('Refresh'),false);
        for(const url of ['data:text/html,attack','file:///private','https://u:p@remote.test'])assert.equal((await call(url)).status,400);
    });
    it('validates each redirect, including External-file redirects reached through random and DAV', async t=>{
        t.mock.method(globalThis,'fetch',async(url,opts)=>{
            assert.equal(opts.redirect,'manual');
            return Response.redirect('https://files.example/a',302);
        });
        const calls=[];
        const env={FETCH_RES_ALLOWED_ORIGINS:'https://files.example',fetchPublicHop:async url=>{
            calls.push(url.href);return Response.redirect('http://localhost:80/private',302);
        }};
        await assert.rejects(fetchFileForDisplay(origin+'/file/x',env),/Unapproved/);
        assert.deepEqual(calls,['https://files.example/a']);
        await assert.rejects(fetchImportedFile(new URL('https://not-listed.example'),env),/Unapproved/);
        assert.equal(calls.length,1);
    });
    it('Docker rejects private IP literals, mapped IPv6 and DNS answers before opening a socket', async()=>{
        for(const host of ['127.1','0x7f000001','169.254.169.254','10.0.0.2','[::1]','[::ffff:127.0.0.1]','[fd00::1]']){
            await assert.rejects(fetchPublicHop(new URL('http://'+host+'/metadata')),/public download/);
        }
        await assert.rejects(fetchPublicHop(new URL('https://rebound.example'),async()=>[
            {address:'8.8.8.8',family:4},{address:'192.168.0.2',family:4},
        ]),/public download/);
        assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
    });
});
