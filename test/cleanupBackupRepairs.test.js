import assert from 'node:assert/strict';
import { it } from 'node:test';
import '../deploy/server/register.mjs';
import { databaseFixture } from './helpers/databaseFixture.js';
import { onRequest as manage } from '../functions/api/manage/_middleware.js';
import { onRequestPost as restore } from '../functions/api/manage/batch/restore/chunk.js';
import { onRequestGet as settings } from '../functions/api/manage/batch/settings.js';
import { createSession } from '../functions/utils/auth/sessionManager.js';
import { resolveWebDAVConfig } from '../functions/utils/webdavConfig.js';
import { WebDAVAPI } from '../functions/utils/storage/webdavAPI.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../functions/utils/metadata/writeSafety.js';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { loadFunction } from './helpers/loadFunction.js';

const { onRequest: cleanup } = await import('../functions/api/manage/cleanup.js');
const origin = 'https://img.test';
const auth = { Authorization: 'Bearer fixture-manage' };
const tokenConfig = JSON.stringify({ apiTokens:{tokens:{m:{token:'fixture-manage',permissions:['manage']}}} });

function invoke(env, request, handler) {
    const context = { env, request, waitUntil(){} };
    return manage[0]({next:()=>manage[1]({...context,next:()=>handler(context)})});
}
function limitQueries(binding) {
    const prepare=binding.prepare.bind(binding);
    let count=0;
    binding.prepare=sql=>{
        const stmt=prepare(sql);
        for(const method of ['first','run','all']) {
            const fn=stmt[method].bind(stmt);
            stmt[method]=async(...args)=>{if(++count>50)throw new Error('D1 Free query limit');return fn(...args);};
        }
        return stmt;
    };
    return { prepare, reset:()=>{count=0;}, used:()=>count };
}

for (const channel of ['CloudflareR2','WebDAV']) it(`D1 Free ${channel}: repeated cleanup reserves quota for final writes`,async t=>{
    const {env,db,seed}=databaseFixture(t,'D1');
    Object.assign(env,{BASIC_USER:'admin',BASIC_PASS:'fixture'});
    const objects=new Set();env.img_r2={async delete(key){objects.delete(key);}};
    if(channel==='WebDAV') {
        await db.put('manage@sysConfig@upload',JSON.stringify({webdav:{channels:[{name:'dav',baseUrl:'https://dav.test',username:'alice',password:'fixture'}]}}));
        t.mock.method(globalThis,'fetch',async(url,opts)=>{
            assert.equal(opts.method,'DELETE');
            objects.delete(new URL(url).pathname.slice(1));
            return new Response(null,{status:204});
        });
    }
    for(let i=0;i<12;i++){
        const id=`old-${i}.txt`;
        const meta=channel==='WebDAV'?{Channel:channel,ChannelName:'dav',WebDAVBaseUrl:'https://dav.test',WebDAVFilePath:id}:{Channel:channel};
        seed(id,'',{...meta,TimeStamp:i+1});objects.add(id);
    }
    await db.put('manage@sysConfig@cleanup',JSON.stringify({dryRun:false,retentionDays:1,batchSize:12}));
    await db.put('manage@sysConfig@security',tokenConfig);
    const budget=limitQueries(env.img_d1);
    for(const remaining of [8,4,0]){
        budget.reset();
        const response=await invoke(env,new Request(`${origin}/api/manage/cleanup`,{method:'PUT',headers:auth}),cleanup);
        assert.equal(response.status,200,await response.clone().text());
        const {result,status}=await response.json();
        assert.equal(result.success,true);assert.equal(result.deleted,4);assert.equal(result.deferred,remaining);
        assert.equal(result.indexUpdatePending,true);assert.equal(status.running,false);
        assert.ok(budget.used()<50,`used ${budget.used()} D1 queries`);
        assert.deepEqual((await budget.prepare('SELECT id FROM file_mutation_claims').all()).results,[]);
        const rows=(await budget.prepare('SELECT id FROM files ORDER BY id').all()).results;
        assert.deepEqual(rows.map(r=>r.id),[...objects].sort());
    }
});

it('Docker SQLite retains the configured cleanup batch rather than the Worker cap',async t=>{
    const {env,db,seed}=databaseFixture(t,'D1');
    env.img_d1.isLocalSQLite=true;
    const deleted=[];env.img_r2={async delete(key){deleted.push(key);}};
    for(let i=0;i<6;i++)seed(`old-${i}.txt`,'',{Channel:'CloudflareR2',TimeStamp:i+1});
    await db.put('manage@sysConfig@cleanup',JSON.stringify({dryRun:false,retentionDays:1,batchSize:6}));
    const response=await invoke(env,new Request(`${origin}/api/manage/cleanup`,{method:'PUT'}),cleanup);
    assert.equal(response.status,200);const {result,status}=await response.json();
    assert.equal(result.deleted,6);assert.equal(result.deferred,0);assert.equal(status.running,false);assert.equal(deleted.length,6);
});

for(const backend of ['KV','D1']) {
    it(`${backend}: settings backup cannot plant sessions or import runtime state`,async t=>{
        const {env,db}=databaseFixture(t,backend);
        Object.assign(env,{BASIC_USER:'admin',BASIC_PASS:'fixture'});
        await db.put('manage@sysConfig@security',tokenConfig);
        const safe={enabled:true,dryRun:true};
        const runtime={
            'session@fake':{authType:'admin',expiresAt:Date.now()+60000},
            'manage@session@fake2':{authType:'admin'},
            'hf-upload@fake':{},'index@meta':{},'sysConfig@cleanupStatus':{running:true},'sysConfig@unknown':{},
        };
        const request=new Request(`${origin}/api/manage/batch/restore/chunk`,{method:'POST',headers:auth,body:JSON.stringify({
            type:'settings',data:{...runtime,'sysConfig@cleanup':safe},
        })});
        const response=await invoke(env,request,restore);const result=await response.json();
        assert.equal(result.restoredCount,1);assert.equal(result.failedCount,Object.keys(runtime).length);
        assert.equal(await db.get('manage@session@fake'),null);assert.equal(await db.get('manage@session@fake2'),null);
        const manageRequest=Cookie=>invoke(env,new Request(`${origin}/api/manage/test`,{headers:{Cookie}}),()=>new Response('authorized'));
        assert.equal((await manageRequest('admin_session=fake')).status,401);
        // Defend even if an old version left malformed sessions behind.
        for(const [id,expiresAt] of [['missing',undefined],['string',String(Date.now()+60000)],['expired',Date.now()-1]]){
            await db.put(`manage@session@${id}`,JSON.stringify({authType:'admin',expiresAt}));
            assert.equal((await manageRequest(`admin_session=${id}`)).status,401);
        }
        const valid=await createSession(env,'admin');
        assert.equal((await manageRequest(`admin_session=${valid.token}`)).status,200);
        await db.put('manage@sysConfig@cleanupStatus',JSON.stringify({running:true}));
        const exported=await invoke(env,new Request(`${origin}/api/manage/batch/settings`,{headers:auth}),settings);
        const backup=(await exported.json()).settings;
        assert.deepEqual(backup['sysConfig@cleanup'],safe);
        assert.deepEqual(Object.keys(backup).sort(),['sysConfig@cleanup','sysConfig@security']);
    });
}

for (const action of ['rename','move']) for (const channel of ['S3','WebDAV']) {
    it(`${action}/${channel}: validates final KV metadata before calling the provider`,async t=>{
        const {env,db,seed}=databaseFixture(t,'KV');
        env.img_d1=databaseFixture(t,'D1').env.img_d1;
        const base='https://storage.test/root';
        await db.put('manage@sysConfig@upload',JSON.stringify({
            s3:{channels:[{name:'s3',endpoint:base,bucketName:'bucket',accessKeyId:'id',secretAccessKey:'secret'}]},
            webdav:{channels:[{name:'dav',baseUrl:base,username:'alice',password:'secret',publicUrl:'https://cdn.test/storage'}]},
        }));
        const source='source.txt';
        const meta=channel==='S3'
            ? {Channel:channel,ChannelName:'s3',S3Endpoint:base,S3BucketName:'bucket',S3FileKey:source,S3CdnFileUrl:'https://cdn.test/source.txt'}
            : {Channel:channel,ChannelName:'dav',WebDAVBaseUrl:base,WebDAVFilePath:source};
        meta.FileName='x'.repeat(960-Buffer.byteLength(JSON.stringify({...meta,FileName:''})));
        seed(source,'',meta);
        let providerWrites=0;
        const route=await loadFunction(`functions/api/manage/${action}/[[path]].js`,{
            getDatabase:createDatabaseAdapter,hydrateFileCredentials,assertLegacyWriteSafe,resolveWebDAVConfig,sanitizeUploadFolder:x=>x,
            S3Client:class {async send(){providerWrites++;}}, CopyObjectCommand:class {}, DeleteObjectCommand:class {},
            WebDAVAPI:class extends WebDAVAPI {async copyFile(){providerWrites++;} async deleteFile(){providerWrites++;}},
            purgeCFCache:async()=>{},purgeRandomFileListCache:async()=>{},purgePublicFileListCache:async()=>{},moveFileInIndex:async()=>{},
        });
        const folder='x'.repeat(100),target=`${folder}/${source}`;
        const relocate=()=>route.onRequest({env,params:{path:source},waitUntil(){},request:new Request(`${origin}/api/manage/${action}/${source}?dist=${folder}`,{
            method:'POST',body:JSON.stringify({newFileId:target}),
        })});
        assert.notEqual((await relocate()).status,200);
        assert.equal(providerWrites,0);
        assert.ok((await db.getWithMetadata(source)).metadata);
        assert.equal(await db.get(target),null);
        seed(source,'',{...meta,FileName:'short.txt'});
        assert.equal((await relocate()).status,200);
        assert.equal(providerWrites,2);
        assert.ok((await db.getWithMetadata(target)).metadata);
    });
}
