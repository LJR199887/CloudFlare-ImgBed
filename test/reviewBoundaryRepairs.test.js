import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalR2Storage } from '../deploy/server/r2Storage.js';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { withFileMutation } from '../functions/utils/fileMutation.js';
import { getHuggingFaceGrant, issueHuggingFaceGrant } from '../functions/utils/huggingFaceGrant.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../functions/utils/metadata/writeSafety.js';
import { onRequest as manage } from '../functions/api/manage/_middleware.js';
import { onRequestPost as restore } from '../functions/api/manage/batch/restore/chunk.js';
import { databaseFixture } from './helpers/databaseFixture.js';
import { loadFunction } from './helpers/loadFunction.js';

const origin = 'https://img.test';
const r2Meta = { Channel: 'CloudflareR2', FileType: 'text/plain' };
const noCache = { purgeCFCache:async()=>{}, purgeRandomFileListCache:async()=>{}, purgePublicFileListCache:async()=>{} };
const restoreRequest = data => new Request(`${origin}/api/manage/batch/restore/chunk`,{method:'POST',body:JSON.stringify({type:'files',data})});
const invokeRestore = (env,data) => {
    const request=restoreRequest(data);
    return manage[0]({next:()=>manage[1]({env,request,next:()=>restore({env,request})})});
};

for (const action of ['rename','move']) for (const failure of ['timeout','403']) {
    it(`S3 ${action} ${failure}: reserve uncertain targets, retain both originals, release definite failures`, async t => {
        const {env,db,seed}=databaseFixture(t,'D1');
        const s3={name:'s3',endpoint:'https://s3.test',bucketName:'bucket',accessKeyId:'id',secretAccessKey:'test'};
        await db.put('manage@sysConfig@upload',JSON.stringify({s3:{channels:[s3]}}));
        const ids=['left/photo.png','right/photo.png'], target='target/photo.png';
        const objects=new Map([[ids[0],'A'],[ids[1],'B']]);
        for(const id of ids)seed(id,'',{Channel:'S3',ChannelName:'s3',S3Endpoint:s3.endpoint,S3BucketName:'bucket',S3FileKey:id,S3CdnFileUrl:`https://cdn.test/${id}`,FileName:id});
        let finishLate;
        class CopyObjectCommand{constructor(input){this.input=input;}}
        class DeleteObjectCommand{constructor(input){this.input=input;}}
        class S3Client{async send(cmd){
            if(cmd instanceof DeleteObjectCommand){objects.delete(cmd.input.Key);return {};}
            const source=cmd.input.CopySource.slice('/bucket/'.length);
            if(source===ids[0]){
                if(failure==='403')throw Object.assign(new Error('forbidden'),{$metadata:{httpStatusCode:403,attempts:1}});
                const body=objects.get(source);
                finishLate=()=>objects.set(cmd.input.Key,body);
                throw Object.assign(new Error('copy was sent but timed out'),{name:'TimeoutError'});
            }
            objects.set(cmd.input.Key,objects.get(source));return {};
        }}
        const route=await loadFunction(`functions/api/manage/${action}/[[path]].js`,{
            ...noCache,getDatabase:createDatabaseAdapter,hydrateFileCredentials,assertLegacyWriteSafe,
            sanitizeUploadFolder:v=>v,moveFileInIndex:async()=>{},S3Client,CopyObjectCommand,DeleteObjectCommand,
        });
        const mutate=id=>route.onRequest({env,params:{path:id.split('/').join(',')},waitUntil(){},request:new Request(`${origin}/api/manage/${action}/${id}?dist=target`,{method:'POST',body:JSON.stringify({newFileId:target})})});
        assert.notEqual((await mutate(ids[0])).status,200);
        const next=await mutate(ids[1]);
        if(failure==='timeout'){
            assert.notEqual(next.status,200);
            finishLate();assert.equal(objects.get(target),'A');
            assert.deepEqual(ids.map(id=>objects.get(id)),['A','B']);
            assert.equal(await db.get(target),null);
        }else{
            assert.equal(next.status,200,await next.clone().text());
            assert.equal(objects.get(target),'B');
            assert.equal(objects.has(ids[1]),false);
            const meta=(await db.getWithMetadata(target)).metadata;
            assert.equal(meta.S3FileKey,target);
            assert.equal(meta.S3CdnFileUrl,undefined,'the moved link must not fetch the old CDN key');
        }
    });
}

it('KV: 1024-byte preflight and deterministic rejection leave the original fence usable', async t => {
    const {env,db,seed}=databaseFixture(t,'KV');env.img_d1=databaseFixture(t,'D1').env.img_d1;
    seed('f.txt','',{...r2Meta,FileName:'old'});
    const update=meta=>withFileMutation(env,['f.txt'],scoped=>createDatabaseAdapter(scoped).put('f.txt','',{metadata:meta}));
    const near='x'.repeat(1010-Buffer.byteLength(JSON.stringify({...r2Meta,FileName:''})));
    await assert.rejects(update({...r2Meta,FileName:near}),{status:413});
    assert.equal((await db.getWithMetadata('f.txt')).metadata.FileName,'old');
    await update({...r2Meta,FileName:'short'});
    const current=(await db.getWithMetadata('f.txt')).metadata;
    const put=env.img_url.put.bind(env.img_url);
    env.img_url.put=async ()=>{throw new Error('KV PUT failed: 429 Rate limited');};
    await assert.rejects(update({...r2Meta,FileName:'rejected'}),/429/);
    assert.deepEqual((await db.getWithMetadata('f.txt')).metadata,current);
    env.img_url.put=put;
    await update({...r2Meta,FileName:'retry'});
    assert.equal((await db.getWithMetadata('f.txt')).metadata.FileName,'retry');
    env.img_url.put=async ()=>{throw new Error('timeout');};
    await assert.rejects(update({...r2Meta,FileName:'ambiguous'}),/timeout/);
    env.img_url.put=put;
    await assert.rejects(update({...r2Meta,FileName:'must not overwrite a possibly committed write'}),{status:409});
});

it('D1 Free: oversized restore is rejected before claiming any files; 5-record batches reserve release budget', async t => {
    const {env,db}=databaseFixture(t,'D1');
    const prepare=env.img_d1.prepare.bind(env.img_d1);let calls=0;
    env.img_d1.prepare=sql=>{
        const stmt=prepare(sql);
        for (const prop of ['first','run','all']) {
            const invoke=stmt[prop].bind(stmt);
            stmt[prop]=async (...args)=>{ if(++calls>50)throw new Error('D1 query budget'); return invoke(...args); };
        }
        return stmt;
    };
    const input=(offset,count)=>Object.fromEntries(Array.from({length:count},(_,i)=>[`f${offset+i}.txt`,{metadata:r2Meta}]));
    assert.equal((await invokeRestore(env,input(0,10))).status,413);
    assert.equal(await db.get('f0.txt'),null);
    for(const offset of [0,5]){
        calls=0;
        const response=await invokeRestore(env,input(offset,5));
        assert.equal(response.status,200);
        assert.equal((await response.json()).restoredCount,5);
        assert.ok(calls<50);
    }
    assert.deepEqual((await prepare('SELECT id FROM file_mutation_claims').all()).results,[]);
});

it('D1: restore reports a written but unreleased record instead of counting it as success', async t => {
    const {env,db}=databaseFixture(t,'D1');const prepare=env.img_d1.prepare.bind(env.img_d1);
    env.img_d1.prepare=sql=>{
        const stmt=prepare(sql);
        if(sql.startsWith('DELETE FROM file_mutation_claims'))stmt.run=async()=>{throw new Error('release unavailable');};
        return stmt;
    };
    const response=await invokeRestore(env,{'f.txt':{metadata:r2Meta}});
    const result=await response.json();
    assert.equal(result.restoredCount,0);assert.equal(result.failedCount,1);
    assert.match(result.errors[0].error,/written.*not released/);
    assert.ok((await db.getWithMetadata('f.txt')).metadata);
});

it('Docker local storage and backup restore reject traversal, symlinks and multipart key swaps', async t => {
    const temp=await realpath(tmpdir());
    const root=await mkdtemp(join(temp,'imgbed-repair-path-'));
    t.after(async()=>{
        const resolved=await realpath(root);
        assert.equal(dirname(resolved),temp);
        assert.ok(basename(resolved).startsWith('imgbed-repair-path-'));
        await rm(resolved,{recursive:true,force:true});
    });
    const storageDir=join(root,'r2');const outside=join(root,'outside');
    await mkdir(outside);await writeFile(join(outside,'canary.txt'),'outside');
    const r2=new LocalR2Storage(storageDir);
    await symlink(outside,join(storageDir,'link'),process.platform==='win32'?'junction':'dir');
    for(const key of ['../outside/canary.txt','link/canary.txt','/outside.txt','dir\\outside.txt','c:outside.txt','a/../b','_multipart/internal']){
        await assert.rejects(r2.get(key));await assert.rejects(r2.put(key,'overwrite'));await assert.rejects(r2.delete(key));
    }
    const {env,db}=databaseFixture(t,'D1');
    const result=await (await invokeRestore(env,{'../outside/canary.txt':{metadata:r2Meta},'safe/f.txt':{metadata:r2Meta}})).json();
    assert.equal(result.restoredCount,1);assert.equal(result.failedCount,1);assert.equal(await db.get('../outside/canary.txt'),null);
    const upload=await r2.createMultipartUpload('safe/f.txt');
    await assert.rejects(r2.resumeMultipartUpload('different.txt',upload.uploadId).abort(),/match/);
    assert.throws(()=>r2.resumeMultipartUpload('safe/f.txt','../../outside'));
    await assert.rejects(upload.uploadPart(0,'no'));
    const part=await upload.uploadPart(1,'ok');
    await upload.complete([part]);
    assert.equal(await new Response((await r2.get('safe/f.txt')).body).text(),'ok');
});

it('D1 grants bind path, ID, content and repository; consumption is atomic', async t => {
    const {env}=databaseFixture(t,'D1');
    const grant={fullId:'new.bin',filePath:`${crypto.randomUUID()}_new.bin`,sha256:'a'.repeat(64),fileSize:12,channelName:'hf',repo:'owner/repo'};
    await issueHuggingFaceGrant(env,grant);
    for(const other of [{fullId:'old.bin'},{filePath:grant.filePath.replace('new','old')},{sha256:'b'.repeat(64)},{fileSize:13},{channelName:'other'}]){
        assert.equal(await getHuggingFaceGrant(env,{...grant,...other}),null);
    }
    const [a,b]=await Promise.all([getHuggingFaceGrant(env,grant),getHuggingFaceGrant(env,grant)]);
    assert.equal(a.grant.repo,'owner/repo');
    assert.deepEqual((await Promise.all([a.consume(),b.consume()])).sort(),[false,true]);
    assert.equal(await getHuggingFaceGrant(env,grant),null);
});
