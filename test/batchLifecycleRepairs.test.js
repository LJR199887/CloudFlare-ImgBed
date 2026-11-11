import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import '../deploy/server/register.mjs';
import { databaseFixture } from './helpers/databaseFixture.js';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { withFileMutation } from '../functions/utils/fileMutation.js';
import { createSession, validateSession } from '../functions/utils/auth/sessionManager.js';
import { mergeOperationsToIndex } from '../functions/utils/indexManager.js';
import { onRequest as manage } from '../functions/api/manage/_middleware.js';
import { onRequest as saveSecurity } from '../functions/api/manage/sysConfig/security.js';
import { onRequest as apiTokens } from '../functions/api/manage/apiTokens.js';
import { onRequestPost as restore } from '../functions/api/manage/batch/restore/chunk.js';
import { onRequestGet as exportFiles } from '../functions/api/manage/batch/list.js';
import { onRequestGet as exportSettings } from '../functions/api/manage/batch/settings.js';
import { onRequestPost as login } from '../functions/api/auth/adminLogin.js';
const { onRequest: cleanup } = await import('../functions/api/manage/cleanup.js');
const { onRequest: move } = await import('../functions/api/manage/move/[[path]].js');
const { onRequest: remove } = await import('../functions/api/manage/delete/[[path]].js');
const origin = 'https://img.test';
const securityKey = 'manage@sysConfig@security';
const metadata = {Channel:'CloudflareR2',TimeStamp:1,FileName:'photo.txt'};
globalThis.caches ??= { default: { async put() {} } };

function withManage(context, handler) {
    return manage[0]({next:()=>manage[1]({...context,next:()=>handler(context)})});
}
function budget(binding) {
    const prepare = binding.prepare.bind(binding); let calls = 0;
    binding.prepare = sql => {
        const stmt = prepare(sql);
        for(const method of ['first','run','all']) {
            const call = stmt[method].bind(stmt);
            stmt[method] = async(...args) => { if(++calls>50) throw new Error('D1 Free query limit'); return call(...args); };
        }
        return stmt;
    };
    return { prepare, reset:()=>{calls=0;}, used:()=>calls };
}

async function shippedFolderHelper() {
    const html = await readFile('frontend-dist/index.html','utf8');
    const helperName = html.match(/folder-mutations\.[a-f0-9]{8}\.js/)[0];
    const runtimeName = html.match(/app\.[a-f0-9]{8}\.js/)[0];
    assert.ok(html.indexOf(helperName) < html.indexOf(runtimeName));
    const runtime=await readFile(`frontend-dist/js/${runtimeName}`,'utf8');
    const dashName=`198.${runtime.match(/198:"([a-f0-9]{8})"/)[1]}.js`;
    const dashboard=await readFile(`frontend-dist/js/${dashName}`,'utf8');
    assert.equal(dashboard.match(/globalThis\.__imgbedFolderMutation\(E\.A,/g).length,4);
    const scope={};
    new Function('globalThis','location','Response',await readFile(`frontend-dist/js/${helperName}`,'utf8'))(scope,{origin},Response);
    return scope.__imgbedFolderMutation;
}

for(const action of ['move','delete']) it(`shipped dashboard: D1 folder ${action} completes across requests without stranding claims`,async t=>{
    const {env,db,seed}=databaseFixture(t,'D1');
    Object.assign(env,{BASIC_USER:'admin',BASIC_PASS:'fixture'});
    const session=await createSession(env,'admin');
    const headers={Authorization:'Bearer not-a-token',Cookie:`admin_session=${session.token}`};
    const ids=Array.from({length:action==='move'?60:8},(_,i)=>i%2===0?`folder/f${i}.txt`:`folder/sub/f${i}.txt`);
    const objects=new Map();
    for(const id of [...ids,'folder2/keep.txt']){seed(id,'',metadata);objects.set(id,id);}
    await db.put('manage@index@meta',JSON.stringify({lastUpdated:1,totalCount:objects.size,chunkCount:1,chunkSize:500}));
    await db.put('manage@index_0',JSON.stringify([...objects.keys()].map(id=>({id,metadata}))));
    env.img_r2={async get(id){return objects.has(id)?{body:objects.get(id)}:null;},async put(id,v){objects.set(id,v);return {};},async delete(id){objects.delete(id);}};
    const limit=budget(env.img_d1),helper=await shippedFolderHelper();
    const path=`/api/manage/${action}/folder?folder=true&dist=dest`;
    const handler=action==='move'?move:remove;
    const request = path => withManage({env,request:new Request(origin+path,{headers}),params:{path:'folder'},waitUntil(){}},handler);
    assert.equal((await request(path)).status,413,'old clients must not mistake the first page for success');
    assert.equal(objects.size,ids.length+1);
    let pages=0;
    const response=await helper(async path=>{
        pages++;limit.reset();
        const page=await request(path);
        assert.equal(page.status,200,await page.clone().text());
        assert.ok(limit.used()<50,`page used ${limit.used()} queries`);
        assert.deepEqual((await limit.prepare('SELECT id FROM file_mutation_claims').all()).results,[]);
        return page;
    },path,{});
    assert.equal(response.status,200);const result=await response.json();assert.equal(pages,ids.length/2);
    assert.equal((action==='move'?result.processed:result.deleted).length,ids.length);
    assert.equal(result.failed.length,0);
    for(const id of ids){assert.equal(objects.has(id),false);if(action==='move')assert.equal(objects.get(`dest/${id}`),id);}
    assert.ok(objects.has('folder2/keep.txt'));
    const indexCount=async()=>(await limit.prepare('SELECT count(*) AS n FROM index_operations').first()).n;
    assert.equal(await indexCount(),pages);
    limit.reset();
    const merged=await mergeOperationsToIndex({env,request:new Request(`${origin}/api/manage/list`),waitUntil(){}});
    assert.equal(merged.success,true);assert.equal(await indexCount(),0);assert.ok(limit.used()<50);
    assert.deepEqual(JSON.parse(await db.get('manage@index_0')).map(file=>file.id).sort(),[...objects.keys()].sort());
});

it('KV primary with D1 coordination follows an opaque continuation, including an empty page',async t=>{
    const {env,seed}=databaseFixture(t,'KV');
    env.img_d1=databaseFixture(t,'D1').env.img_d1;
    const ids=['folder/a','folder/b','folder/c'], remaining=new Set(ids);
    for(const id of ids)seed(id,'',metadata);
    env.img_r2={async delete(id){remaining.delete(id);}};
    const kv=env.img_url,list=kv.list.bind(kv);
    kv.list=async options=>{
        if(options.prefix!=='folder/')return list(options);
        assert.equal(options.limit,2);
        if(options.cursor==='first +=')return {keys:[],list_complete:false,cursor:'second/%'};
        const keys=(await list(options)).keys.slice(0,2);
        if(options.cursor==='second/%')return {keys,list_complete:true};
        assert.equal(options.cursor,undefined);
        return {keys,list_complete:false,cursor:'first +='};
    };
    const helper=await shippedFolderHelper();
    const response=await helper(path=>withManage({env,request:new Request(origin+path),params:{path:'folder'},waitUntil(){}},remove),
        '/api/manage/delete/folder?folder=true',{});
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual((await response.json()).deleted,ids);
    assert.equal(remaining.size,0);
});

it('dashboard reports partial folder failures without hiding unprocessed files',async()=>{
    const helper=await shippedFolderHelper();let n=0;
    const response=await helper(async()=>++n===1
        ? Response.json({success:true,failed:['folder/blocked.txt'],nextCursor:'first'})
        : Response.json({success:true,deleted:['folder/ok.txt'],nextCursor:null}),
    '/api/manage/delete/folder?folder=true',{});
    assert.equal(n,2);assert.equal(response.status,409);
    const body=await response.json();assert.deepEqual(body.deleted,['folder/ok.txt']);assert.deepEqual(body.failed,['folder/blocked.txt']);
});

it('cleanup resumes after stuck records even when all timestamps are identical',async t=>{
    const {env,db,seed}=databaseFixture(t,'D1');const objects=new Set();
    env.img_r2={async delete(id){objects.delete(id);}};
    for(let i=0;i<8;i++){
        const id=`old-${i}.txt`;seed(id,'',metadata);objects.add(id);
        if(i<4)await withFileMutation(env,[id],async(_,retain)=>retain(id));
    }
    await db.put('manage@sysConfig@cleanup',JSON.stringify({dryRun:false,retentionDays:1,batchSize:8}));
    const limit=budget(env.img_d1);
    const run=async()=>{
        limit.reset();const r=await withManage({env,request:new Request(`${origin}/api/manage/cleanup`,{method:'PUT'}),waitUntil(){}},cleanup);
        assert.equal(r.status,200);assert.ok(limit.used()<50);return r.json();
    };
    const first=await run();assert.equal(first.result.failed,4);assert.equal(first.result.hasMore,true);
    const second=await run();assert.equal(second.result.deleted,4);assert.equal(second.result.hasMore,false);assert.equal(second.status.running,false);
    assert.deepEqual([...objects],['old-0.txt','old-1.txt','old-2.txt','old-3.txt']);
});

for(const backend of ['KV','D1']) it(`${backend}: security restore invalidates both old session scopes in one settings write`,async t=>{
    const {env,db}=databaseFixture(t,backend);Object.assign(env,{BASIC_USER:'admin',BASIC_PASS:'old-password',AUTH_CODE:'old-code'});
    const admin=await createSession(env,'admin'),user=await createSession(env,'user');
    const req=(scope,token)=>new Request(`${origin}/api/manage/settings`,{headers:{Cookie:`${scope}_session=${token}`}});
    const backup={auth:{admin:{adminUsername:'admin',adminPassword:'new-password'},user:{authCode:'new-code'}},sessionEpochs:{admin:'injected',user:'injected'}};
    const request=new Request(`${origin}/api/manage/batch/restore/chunk`,{method:'POST',headers:req('admin',admin.token).headers,body:JSON.stringify({type:'settings',data:{'sysConfig@security':backup}})});
    assert.equal((await (await withManage({env,request},restore)).json()).restoredCount,1);
    assert.equal((await validateSession(env,req('admin',admin.token),'admin')).valid,false);
    assert.equal((await validateSession(env,req('user',user.token),'user')).valid,false);
    assert.notEqual(JSON.parse(await db.get(securityKey)).sessionEpochs.admin,'injected');
    const response=await login({env,request:new Request(`${origin}/api/auth/adminLogin`,{method:'POST',body:JSON.stringify({username:'admin',password:'new-password'})})});
    assert.equal(response.status,200);
    const fresh=new Request(`${origin}/api/manage/settings`,{headers:{Cookie:response.headers.get('Set-Cookie').split(';')[0]}});
    assert.equal((await withManage({env,request:fresh},()=>new Response('ok'))).status,200);
    const backupResponse=await exportSettings({env,request:new Request(`${origin}/api/manage/batch/settings`)});
    assert.equal((await backupResponse.json()).settings['sysConfig@security'].sessionEpochs,undefined);
});

for(const [name,handler,method,body] of [
    ['security save',saveSecurity,'POST',{access:{whiteListMode:true}}],
    ['API token creation',apiTokens,'POST',{name:'fixture',owner:'admin',permissions:['list']}],
]) it(`D1 ${name} cannot restore stale credentials or epochs after an intervening restore`,async t=>{
    const {env,db}=databaseFixture(t,'D1');
    await db.put(securityKey,JSON.stringify({auth:{admin:{adminUsername:'admin',adminPassword:'old'}},sessionEpochs:{admin:'before'}}));
    const prepare=env.img_d1.prepare.bind(env.img_d1);
    let intervened=false;
    env.img_d1.prepare=sql=>{
        const statement=prepare(sql);
        if(sql.startsWith('UPDATE settings SET value')){
            const run=statement.run.bind(statement);
            statement.run=async()=>{
                const request=new Request(`${origin}/api/manage/batch/restore/chunk`,{method:'POST',body:JSON.stringify({
                    type:'settings',data:{'sysConfig@security':{auth:{admin:{adminUsername:'admin',adminPassword:'restored'}}}},
                })});
                assert.equal((await (await restore({env,request})).json()).restoredCount,1);
                intervened=true;
                return run();
            };
        }
        return statement;
    };
    const response=await handler({env,request:new Request(`${origin}/api/manage`,{method,body:JSON.stringify(body)})});
    assert.ok(intervened);assert.equal(response.status,409);
    const current=JSON.parse(await db.get(securityKey));
    assert.notEqual(current.sessionEpochs.admin,'before');assert.equal(current.auth.admin.adminPassword,'restored');
});

it('portable backups omit source version markers and legacy imports do not poison later coordination',async t=>{
    const source=databaseFixture(t,'KV');source.env.img_d1=databaseFixture(t,'D1').env.img_d1;
    await withFileMutation(source.env,['photo.txt'],env=>createDatabaseAdapter(env).put('photo.txt','',{metadata}));
    const exported=await exportFiles({env:source.env,request:new Request(`${origin}/api/manage/batch/list?includeValue=true`)});
    const {records}=await exported.json();assert.equal(records[0].metadata.FileMutationGeneration,undefined);
    const legacy={...records[0].metadata,FileMutationGeneration:'legacy-source-fence'};
    const dest=databaseFixture(t,'KV');
    const response=await restore({env:dest.env,request:new Request(`${origin}/api/manage/batch/restore/chunk`,{method:'POST',body:JSON.stringify({type:'files',data:{'photo.txt':{metadata:legacy}}})})});
    assert.equal((await response.json()).restoredCount,1);
    assert.equal((await dest.db.getWithMetadata('photo.txt')).metadata.FileMutationGeneration,undefined);
    dest.env.img_d1=databaseFixture(t,'D1').env.img_d1;
    await withFileMutation(dest.env,['photo.txt'],env=>createDatabaseAdapter(env).put('photo.txt','',{metadata:{...metadata,FileName:'new.txt'}}));
    assert.equal((await dest.db.getWithMetadata('photo.txt')).metadata.FileName,'new.txt');
});
