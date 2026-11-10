import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { fetchPublicHop } from '../deploy/server/publicDownload.js';
import { createDecodedFetch } from '../deploy/server/decodedFetch.js';
import { applyDownloadPolicy } from '../functions/utils/downloadPolicy.js';
import { onRequest as manage } from '../functions/api/manage/_middleware.js';
import { databaseFixture } from './helpers/databaseFixture.js';
import { loadFunction } from './helpers/loadFunction.js';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { stripSensitiveMetadata } from '../functions/utils/metadata/metadataSecurity.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../functions/utils/metadata/writeSafety.js';
import { prepareMetadataForStorage } from '../functions/utils/metadata/webdavIdentity.js';
import { resolveWebDAVConfig } from '../functions/utils/webdavConfig.js';
import { WebDAVAPI } from '../functions/utils/storage/webdavAPI.js';

async function localServer(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
}

describe('review: hostile HTTP and decoded transport', () => {
    it('rejects status 700 from a real HTTP parser without an uncaught callback exception', async t => {
        const local = await localServer(t, (_req, res) => { res.writeHead(700); res.end('invalid'); });
        const get = http.get;
        // Only redirect the physical connection; exercise the real parser and
        // production callback, not a synthetic Response (which rejects 700).
        t.mock.method(http, 'get', (_url, options, callback) => get(local, { ...options, lookup: undefined }, callback));
        await assert.rejects(fetchPublicHop(new URL('http://8.8.8.8/')), /Invalid download response status/);
    });
    for (const [encoding, compress] of [['gzip', gzipSync], ['x-gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync], ['gzip, br', b=>brotliCompressSync(gzipSync(b))]]) {
        it(`relays Node-decoded ${encoding} bytes without stale wire headers`, async t => {
            const bytes = Buffer.from('hello compressed download '.repeat(30));
            const compressed = compress(bytes);
            const upstream = await localServer(t, (req, res) => {
                const partial = req.url === '/partial';
                res.writeHead(partial ? 206 : 200, {
                    'Content-Encoding': encoding, 'Content-Length': compressed.length, 'Content-Type': 'text/plain',
                    ...(partial ? { 'Content-Range': `bytes 0-${compressed.length-1}/${compressed.length}` } : {}),
                });
                res.end(compressed);
            });
            const download = createDecodedFetch(fetch);
            const relay = await localServer(t, async (_req, res) => {
                const response = await download(upstream);
                res.writeHead(response.status, Object.fromEntries(response.headers));
                for await (const chunk of response.body) res.write(chunk);
                res.end();
            });
            const response = await fetch(relay);
            assert.equal(response.headers.get('Content-Encoding'), null);
            assert.equal(response.headers.get('Content-Length'), null);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
            const head = await download(new Request(upstream, { method: 'HEAD' }));
            assert.equal(head.headers.get('Content-Encoding'), encoding);
            assert.equal(head.headers.get('Content-Length'), String(compressed.length));
            await assert.rejects(download(upstream+'/partial'), /Compressed partial/);
            const native = http.get;
            t.mock.method(http, 'get', (_url, options, callback) => native(upstream, { ...options, lookup: undefined }, callback));
            const raw = await fetchPublicHop(new URL('http://8.8.8.8/'));
            assert.equal(raw.headers.get('Content-Encoding'), encoding);
            assert.deepEqual(Buffer.from(await raw.arrayBuffer()), compressed);
        });
    }
    it('retains unencoded Range and 304 responses and fetch response properties', async () => {
        const partial = new Response('part', { status:206, headers:{'Content-Range':'bytes 0-3/10','Content-Length':'4'} });
        assert.equal(await createDecodedFetch(async()=>partial)('http://test'), partial);
        const cached = new Response(null, { status:304, headers:{'Content-Encoding':'gzip'} });
        assert.equal(await createDecodedFetch(async()=>cached)('http://test'), cached);
        const encoded = new Response('decoded', { headers:{'Content-Encoding':'gzip','Content-Length':'100'} });
        Object.defineProperties(encoded, {url:{value:'https://test/final'},redirected:{value:true}});
        const normalized = await createDecodedFetch(async()=>encoded)('https://test');
        assert.equal(normalized.url,encoded.url); assert.equal(normalized.redirected,true);
        assert.equal(await normalized.text(),'decoded');
    });
    it('negotiates known codecs and refuses version-dependent or unknown encodings', async t => {
        const seen = [];
        const upstream = await localServer(t, (req,res) => {
            seen.push(req.headers['accept-encoding']);
            res.writeHead(200, {'Content-Encoding':'x-unknown'}); res.end('bytes');
        });
        const download = createDecodedFetch(fetch);
        await assert.rejects(download(upstream), /Unsupported download content encoding/);
        await assert.rejects(download(new Request(upstream,{headers:{Range:'bytes=0-1'}})), /Unsupported download content encoding/);
        assert.deepEqual(seen, ['gzip, deflate, br','identity']);
    });
});

describe('review: canonical MIME and route permissions', () => {
    it('never emits ambiguous parameters as an executable MIME', () => {
        for (const type of ['text/plain; a=b, text/javascript','text/plain; a=b, application/javascript','image/png; a=b, text/javascript', 'text/plain; charset="utf-8, text/javascript"']) {
            const headers = new Headers(); applyDownloadPolicy(headers,type);
            assert.equal(headers.get('Content-Type'),'application/octet-stream');
            assert.match(headers.get('Content-Disposition'),/^attachment;/);
        }
        const h = new Headers(); applyDownloadPolicy(h,'TEXT/PLAIN; ignored="anything"; charset="UTF-8"');
        assert.equal(h.get('Content-Type'),'text/plain; charset=UTF-8');
    });
    for (const backend of ['KV','D1']) {
        it(`${backend}: real list/delete tokens cannot mutate metadata through reserved file segments`, async t => {
            const {env,db,seed} = databaseFixture(t,backend);
            env.BASIC_USER='administrator'; env.BASIC_PASS='fixture-only';
            await db.put('manage@sysConfig@security',JSON.stringify({apiTokens:{tokens:{
                readonly:{token:'list-token',permissions:['list']},delete:{token:'delete-token',permissions:['delete']},manager:{token:'manage-token',permissions:['manage']},
            }}}));
            const metadata = await loadFunction('functions/api/manage/metadata/[[path]].js',{
                getDatabase:createDatabaseAdapter,stripSensitiveMetadata,addFileToIndex:async()=>{},
            });
            async function invoke(path, token, method='GET', next=()=>new Response('allowed')) {
                const request = new Request('https://img.test/api/manage/'+path,{
                    method,headers:{Authorization:'Bearer '+token},...(method==='PATCH'?{body:JSON.stringify({FileName:'changed'})}:{}),
                });
                return manage[0]({next:()=>manage[1]({env,request,next:()=>next(request)})});
            }
            for (const id of ['list/probe.png','delete/probe.png','nested/list/probe.png']) {
                seed(id,'',{Channel:'CloudflareR2',FileName:'original'});
                const handler = request=>metadata.onRequest({env,request,params:{path:id},waitUntil(){}});
                for (const token of ['list-token','delete-token']) {
                    assert.equal((await invoke('metadata/'+id,token,'PATCH',handler)).status,401);
                    assert.equal((await db.getWithMetadata(id)).metadata.FileName,'original');
                }
                assert.equal((await invoke('metadata/'+id,'manage-token','PATCH',handler)).status,200);
            }
            for (const path of ['list','list?dir=delete/list','list?action=info','list?action=index-storage-stats']) assert.equal((await invoke(path,'list-token')).status,200,path);
            for (const path of ['list?action=rebuild','list?action=merge-operations','list?action=delete-operations','list?action=unknown','move/list/file.png','rename/list/file.png','apiTokens/list']) {
                assert.equal((await invoke(path,'list-token')).status,401,path);
                assert.equal((await invoke(path,'manage-token')).status,200,path);
            }
            assert.equal((await invoke('list','list-token','POST')).status,401);
            assert.equal((await invoke('delete/list/probe.png','delete-token','DELETE')).status,200);
            assert.equal((await invoke('delete/list/probe.png','list-token','DELETE')).status,401);
        });
    }
});

const noCache = {purgeCFCache:async()=>{},purgeRandomFileListCache:async()=>{},purgePublicFileListCache:async()=>{}};
const uploadConfig = {
    s3:{channels:[{name:'s3',endpoint:'https://s3.test',bucketName:'bucket',accessKeyId:'id',secretAccessKey:'secret'}]},
    webdav:{channels:[{name:'dav',baseUrl:'https://dav.test/root/',username:'alice',password:'secret'}]},
};
const examples = [
    {Channel:'CloudflareR2'},
    {Channel:'S3',ChannelName:'s3',S3Endpoint:'https://s3.test',S3BucketName:'bucket',S3FileKey:'old.png'},
    {Channel:'WebDAV',ChannelName:'dav',WebDAVBaseUrl:'https://dav.test/root/',WebDAVFilePath:'old.png'},
];

describe('review: relocation failure ordering', () => {
    for (const backend of ['KV','D1']) for (const action of ['rename','move']) for (const example of examples) {
        for (const failure of ['copy','put','delete-row','delete-object',null]) {
            it(`${backend} ${action} ${example.Channel}: ${failure || 'success'}`,async t=>{
                const {env,db,seed}=databaseFixture(t,backend);
                await db.put('manage@sysConfig@upload',JSON.stringify(uploadConfig));
                const m=await prepareMetadataForStorage(await hydrateFileCredentials(env,example));
                seed('old.png','',m);
                const target=action==='move'?'new/old.png':'new.png';
                const objects=new Map([['old.png','bytes']]);
                const steps=[];
                const copy=async (oldKey,newKey)=>{
                    steps.push('copy'); if(failure==='copy')throw new Error('injected copy failure');
                    assert.ok(objects.has(oldKey)); objects.set(newKey,objects.get(oldKey));
                };
                const remove=async key=>{
                    steps.push('delete-object');
                    assert.ok((await db.getWithMetadata(target))?.metadata,'target must be committed');
                    assert.equal((await db.getWithMetadata('old.png'))?.metadata??null,null,'old row must be removed before object cleanup');
                    if(failure==='delete-object')throw new Error('injected object delete failure');
                    objects.delete(key);
                };
                env.img_r2={get:async key=>({body:objects.get(key)}),put:async key=>copy('old.png',key),delete:remove};
                const put=db.put.bind(db), del=db.delete.bind(db);
                db.put=async (...args)=>{steps.push('put');if(failure==='put')throw new Error('injected db put failure'); return put(...args);};
                db.delete=async (...args)=>{steps.push('delete-row');if(failure==='delete-row')throw new Error('injected db delete failure');return del(...args);};
                // Use the real WebDAV implementation against a controlled wire
                // peer; the S3 command transport alone is stubbed.
                t.mock.method(globalThis,'fetch',async (url,options)=>{
                    if(options.method==='MKCOL')return new Response(null,{status:201});
                    const key=decodeURIComponent(new URL(url).pathname.slice('/root/'.length));
                    if(options.method==='COPY'){
                        assert.equal(options.headers.get('Overwrite'),'F');
                        await copy(key,decodeURIComponent(new URL(options.headers.get('Destination')).pathname.slice('/root/'.length)));
                        return new Response(null,{status:201});
                    }
                    assert.equal(options.method,'DELETE'); await remove(key);return new Response(null,{status:204});
                });
                const route=await loadFunction(`functions/api/manage/${action}/[[path]].js`,{
                    ...noCache,getDatabase:()=>db,hydrateFileCredentials,assertLegacyWriteSafe,prepareMetadataForStorage,
                    resolveWebDAVConfig,WebDAVAPI,sanitizeUploadFolder:v=>v,moveFileInIndex:async()=>{},
                    S3Client:class{async send(command){return command.kind==='copy'?copy(decodeURIComponent(command.input.CopySource.slice('/bucket/'.length)),command.input.Key):remove(command.input.Key);}},
                    CopyObjectCommand:class{constructor(input){this.input=input;this.kind='copy';}},DeleteObjectCommand:class{constructor(input){this.input=input;this.kind='delete';}},
                });
                const request=new Request(`https://img.test/api/manage/${action}/old.png?dist=new`,{method:'POST',body:JSON.stringify({newFileId:target})});
                const response=await route.onRequest({env,request,params:{path:'old.png'},waitUntil(){}});
                if(['copy','put','delete-row'].includes(failure)){
                    assert.notEqual(response.status,200);
                    assert.equal(objects.get('old.png'),'bytes');
                    assert.ok((await db.getWithMetadata('old.png'))?.metadata);
                    assert.ok(!steps.includes('delete-object'));
                    if(failure==='delete-row')assert.ok((await db.getWithMetadata(target))?.metadata);
                }else{
                    assert.equal(response.status,200,await response.clone().text());
                    const result=await response.json();
                    assert.deepEqual(steps,['copy','put','delete-row','delete-object']);
                    assert.equal(objects.get(target),'bytes');
                    assert.ok((await db.getWithMetadata(target))?.metadata);
                    assert.equal(objects.has('old.png'),failure==='delete-object');
                    assert.equal(result.warnings?.length||0,failure==='delete-object'?1:0);
                }
            });
        }
    }
    it('rejects WebDAV partial COPY success instead of deleting a source',async t=>{
        t.mock.method(globalThis,'fetch',async()=>new Response('<multistatus/>',{status:207}));
        await assert.rejects(new WebDAVAPI({baseUrl:'https://dav.test',createDirectory:false}).copyFile('old','new'),/COPY failed: 207/);
    });
});
