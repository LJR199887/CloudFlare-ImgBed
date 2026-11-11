import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { onRequest as manage } from '../functions/api/manage/_middleware.js';
import { authenticate, AUTH_SCOPE } from '../functions/utils/auth/authCore.js';
import { fetchSecurityConfig } from '../functions/utils/sysConfig.js';
import { onRequestPost as adminLogin } from '../functions/api/auth/adminLogin.js';
import { createSession } from '../functions/utils/auth/sessionManager.js';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { databaseFixture } from './helpers/databaseFixture.js';
import { loadFunction } from './helpers/loadFunction.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../functions/utils/metadata/writeSafety.js';
import { prepareMetadataForStorage } from '../functions/utils/metadata/webdavIdentity.js';

function failSecurityReads(t, env) {
    if (env.img_url) {
        const original = env.img_url.get.bind(env.img_url);
        t.mock.method(env.img_url, 'get', async key => {
            if (key === 'manage@sysConfig@security') throw new Error('injected security read outage');
            return original(key);
        });
    } else {
        const prepare = env.img_d1.prepare.bind(env.img_d1);
        t.mock.method(env.img_d1, 'prepare', sql => {
            const statement = prepare(sql), bind = statement.bind.bind(statement), first = statement.first.bind(statement);
            let key;
            statement.bind = (...args) => { key=args[0]; return bind(...args); };
            statement.first = async () => {
                if (sql.includes('FROM settings') && key === 'manage@sysConfig@security') throw new Error('injected security read outage');
                return first();
            };
            return statement;
        });
    }
}
async function invokeManage(env, headers={}) {
    let reached = false;
    const request = new Request('https://img.test/api/manage/metadata/file.png',{method:'PATCH',headers,body:'{}'});
    const response = await manage[0]({next:()=>manage[1]({env,request,next:()=>{reached=true;return new Response('protected');}})});
    return {response,reached};
}

describe('security settings fail closed', () => {
    for (const backend of ['KV','D1']) {
        it(`${backend}: absence uses env defaults, explicit anonymous mode still works`,async t=>{
            const {env,db}=databaseFixture(t,backend);
            assert.equal((await invokeManage(env)).response.status,200);
            env.BASIC_USER='admin';env.BASIC_PASS='fixture-password';
            assert.equal((await invokeManage(env)).response.status,401);
            await db.put('manage@sysConfig@security',JSON.stringify({auth:{admin:{adminUsername:'',adminPassword:''}}}));
            assert.equal((await invokeManage(env)).response.status,200);
        });
        for (const credentials of ['env','database']) {
            it(`${backend}/${credentials}: outage denies anonymous, valid tokens and sessions in every auth scope`,async t=>{
                const {env,db}=databaseFixture(t,backend);
                const auth={admin:{adminUsername:'admin',adminPassword:'fixture-password'},user:{authCode:'fixture-auth-code'}};
                if(credentials==='env')Object.assign(env,{BASIC_USER:'admin',BASIC_PASS:'fixture-password',AUTH_CODE:'fixture-auth-code'});
                await db.put('manage@sysConfig@security',JSON.stringify({
                    ...(credentials==='database'?{auth}:{}),apiTokens:{tokens:{valid:{token:'fixture-token',permissions:['manage','upload','list','delete']}}},
                }));
                const session = await createSession(env,'admin');
                const headersList=[{}, {Authorization:'Bearer fixture-token'}, {Cookie:`admin_session=${session.token}`}];
                assert.equal((await invokeManage(env,headersList[0])).response.status,401);
                for(const headers of headersList.slice(1))assert.equal((await invokeManage(env,headers)).response.status,200);
                failSecurityReads(t,env);
                for (const headers of headersList) {
                    const {response,reached}=await invokeManage(env,headers);
                    assert.equal(response.status,401); assert.equal(reached,false);
                    for (const authScope of Object.values(AUTH_SCOPE)) {
                        const result=await authenticate({env,request:new Request('https://img.test/',{headers}),authScope,requiredPermission:'manage'});
                        assert.equal(result.authorized,false,authScope);
                    }
                }
                await assert.rejects(fetchSecurityConfig(env),/Security configuration unavailable/);
                await assert.rejects(adminLogin({env,request:new Request('https://img.test/api/auth/adminLogin',{
                    method:'POST',body:JSON.stringify({username:'',password:''}),
                })}),/Security configuration unavailable/);
                await assert.rejects(createSession(env,'admin'),/Security configuration unavailable/);
            });
        }
        for (const value of ['{','', 'null','[]','42','"broken"','{"auth":false}','{"auth":{"admin":[]}}','{"auth":{"admin":{"adminPassword":false}}}']) {
            it(`${backend}: rejects malformed security settings ${value}`,async t=>{
                const {env,db}=databaseFixture(t,backend);
                await db.put('manage@sysConfig@security',value);
                const {response,reached}=await invokeManage(env);
                assert.equal(response.status,401);assert.equal(reached,false);
            });
        }
    }
});

const noCache={purgeCFCache:async()=>{},purgeRandomFileListCache:async()=>{},purgePublicFileListCache:async()=>{}};
describe('source name reuse during relocation',()=>{
    for(const backend of ['KV','D1'])for(const action of ['rename','move']) {
        it(`${backend} ${action}: real upload naming cannot reuse a source while object cleanup is pending`,async t=>{
            const {env,db,seed}=databaseFixture(t,backend);
            seed('old.png','',{Channel:'CloudflareR2',FileName:'old.png',FileType:'image/png'});
            const target=action==='move'?'new/old.png':'new.png';
            const objects=new Map([['old.png','ORIGINAL']]);
            let entered,release;
            const cleaning=new Promise(r=>entered=r),resume=new Promise(r=>release=r);
            env.img_r2={
                get:async k=>objects.has(k)?{body:objects.get(k)}:null,
                put:async(k,v)=>objects.set(k,typeof v==='string'?v:await v.text()),
                delete:async k=>{entered();await resume;objects.delete(k);},
            };
            const uploadTools=await loadFunction('functions/upload/uploadTools.js',{getDatabase:createDatabaseAdapter});
            const route=await loadFunction(`functions/api/manage/${action}/[[path]].js`,{
                ...noCache,getDatabase:()=>db,hydrateFileCredentials,assertLegacyWriteSafe,prepareMetadataForStorage,
                sanitizeUploadFolder:uploadTools.sanitizeUploadFolder,moveFileInIndex:async()=>{},
            });
            const uploader=await loadFunction('functions/upload/index.js',{
                ...uploadTools,getDatabase:createDatabaseAdapter,userAuthCheck:async()=>true,
                getUploadIp:()=>'',getIPAddress:async()=>'',isBlockedUploadIp:async()=>false,
                fetchSecurityConfig:async()=>({upload:{moderate:{enabled:false}}}),
                fetchUploadConfig:async()=>({cfr2:{channels:[{name:'R2_env'}]}}),
                moderateContent:async()=> 'None',endUpload:async()=>{},getImageDimensions:()=>null,
            });
            const upload=async value=>{
                const form=new FormData();form.set('file',new File([value],'old.png',{type:'image/png'}));
                const response=await uploader.onRequest({env,waitUntil(){},request:new Request('https://img.test/upload?uploadChannel=cfr2&uploadNameType=origin&autoRetry=false',{method:'POST',body:form})});
                assert.equal(response.status,200,await response.clone().text());return (await response.json())[0].src;
            };
            const pending=route.onRequest({env,params:{path:'old.png'},waitUntil(){},request:new Request(`https://img.test/api/manage/${action}/old.png?dist=new`,{method:'POST',body:JSON.stringify({newFileId:target})})});
            await cleaning;
            let concurrent;
            try {
                assert.ok((await db.getWithMetadata('old.png'))?.metadata,'source name must still be reserved');
                concurrent=await upload('DURING CLEANUP');
                assert.equal(concurrent,'/file/old(1).png');
            } finally { release(); }
            const result=await pending;
            assert.equal(result.status,200,await result.clone().text());
            assert.equal(objects.get('old(1).png'),'DURING CLEANUP');
            assert.equal(objects.get(target),'ORIGINAL');
            assert.equal(objects.has('old.png'),false);
            assert.equal(await upload('AFTER CLEANUP'),'/file/old.png');
            assert.equal(objects.get('old.png'),'AFTER CLEANUP');
            assert.equal(objects.get('old(1).png'),'DURING CLEANUP');
        });
    }
});
