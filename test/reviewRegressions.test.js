import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';
import { D1Database } from '../functions/utils/d1Database.js';
import { hydrateFileCredentials } from '../functions/utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../functions/utils/metadata/writeSafety.js';
import { getWebDAVAccountId } from '../functions/utils/metadata/webdavIdentity.js';
import { resolveWebDAVConfig } from '../functions/utils/webdavConfig.js';
import { loadFunction } from './helpers/loadFunction.js';

function fixture(config, metadata) {
    const rows = new Map([
        ['manage@sysConfig@upload', { value: JSON.stringify(config) }],
        ['file.png', { value: '', metadata: structuredClone(metadata) }],
    ]);
    const env = { img_url: {
        async get(k) { return rows.get(k)?.value ?? null; },
        async getWithMetadata(k) { return structuredClone(rows.get(k) ?? { value: null, metadata: null }); },
        async put(k, value, options = {}) { rows.set(k, { value, metadata: structuredClone(options.metadata) }); },
        async delete(k) { rows.delete(k); },
    } };
    return { env, rows, db: createDatabaseAdapter(env) };
}

describe('second-review regressions', () => {
    for (const Channel of ['S3', 'CloudflareR2', 'WebDAV']) {
        for (const orphaned of [false, true]) {
            it(`rejects ${Channel} move collisions before any storage changes (${orphaned ? 'legacy' : 'ordinary'} target)`, async () => {
                const metadata = { Channel, ChannelName: 'source', S3FileKey: 'file.png' };
                const { env, rows } = fixture({}, metadata);
                const destination = orphaned
                    ? { Channel: 'S3', ChannelName: 'removed', S3BucketName: 'old', S3SecretAccessKey: 'orphan-secret' }
                    : { Channel: 'CloudflareR2' };
                rows.set('other/file.png', { value: '', metadata: destination });
                let mutations = 0;
                env.img_r2 = { async get() { mutations++; }, async put() { mutations++; }, async delete() { mutations++; } };
                const route = await loadFunction('functions/api/manage/move/[[path]].js', {
                    getDatabase: createDatabaseAdapter, assertLegacyWriteSafe, hydrateFileCredentials,
                    sanitizeUploadFolder: value => value,
                    S3Client: class { async send() { mutations++; } },
                    WebDAVAPI: class { async moveFile() { mutations++; } },
                });
                const response = await route.onRequest({ env, params: { path: 'file.png' }, waitUntil() {},
                    request: new Request('https://img.example/api/manage/move/file.png?dist=other'),
                });
                assert.notEqual(response.status, 200);
                assert.equal(mutations, 0);
                assert.deepEqual(rows.get('file.png').metadata, metadata);
                assert.deepEqual(rows.get('other/file.png').metadata, destination);
            });
        }
    }

    it('treats moving to the same key as a storage no-op', async () => {
        const { env, rows } = fixture({}, { Channel: 'S3', S3SecretAccessKey: 'legacy' });
        const route = await loadFunction('functions/api/manage/move/[[path]].js', {
            getDatabase: createDatabaseAdapter, sanitizeUploadFolder: value => value,
            assertLegacyWriteSafe: () => { throw new Error('should not run'); },
            moveFileInIndex: async () => {},
        });
        const response = await route.onRequest({ env, params: { path: 'file.png' }, waitUntil() {},
            request: new Request('https://img.example/api/manage/move/file.png'),
        });
        assert.equal(response.status, 200);
        assert.equal(rows.get('file.png').metadata.S3SecretAccessKey, 'legacy');
    });

    it('still moves S3 files to an empty destination and saves credential-free metadata', async () => {
        const metadata = { Channel: 'S3', ChannelName: 's3', S3Endpoint: 'https://s3.example', S3BucketName: 'A', S3FileKey: 'file.png' };
        const { env, rows } = fixture({ s3: { channels: [{ name: 's3', endpoint: metadata.S3Endpoint, bucketName: 'A', accessKeyId: 'id', secretAccessKey: 'secret' }] } }, metadata);
        const mutations = [];
        const route = await loadFunction('functions/api/manage/move/[[path]].js', {
            getDatabase: createDatabaseAdapter, assertLegacyWriteSafe, hydrateFileCredentials,
            sanitizeUploadFolder: value => value, moveFileInIndex: async () => {},
            S3Client: class { async send(command) { mutations.push(command.kind); } },
            CopyObjectCommand: class { constructor() { this.kind = 'copy'; } },
            DeleteObjectCommand: class { constructor() { this.kind = 'delete'; } },
            purgeCFCache: async () => {}, purgeRandomFileListCache: async () => {}, purgePublicFileListCache: async () => {},
        });
        const response = await route.onRequest({ env, params: { path: 'file.png' }, waitUntil() {},
            request: new Request('https://img.example/api/manage/move/file.png?dist=other'),
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(mutations, ['copy', 'delete']);
        assert.equal(rows.has('file.png'), false);
        assert.equal(rows.get('other/file.png').metadata.S3FileKey, 'other/file.png');
        assert.equal(rows.get('other/file.png').metadata.S3SecretAccessKey, undefined);
    });

    it('binds the WebDAV account during a normal upload without storing its credentials', async () => {
        const channel = { name: 'dav', baseUrl: 'https://dav.example/root', username: 'alice', password: 'password' };
        const { env, rows, db } = fixture({ webdav: { channels: [channel] } });
        rows.delete('file.png');
        const route = await loadFunction('functions/upload/index.js', {
            getDatabase: () => db, getWebDAVAccountId,
            fetchUploadConfig: async () => ({ webdav: { channels: [channel] } }),
            fetchSecurityConfig: async () => ({ upload: { moderate: { enabled: false } } }),
            userAuthCheck: async () => true, isBlockedUploadIp: async () => false,
            getUploadIp: () => '', getIPAddress: async () => '',
            buildUniqueFileId: async () => 'file.png', resolveFileExt: () => 'png',
            sanitizeUploadFolder: value => value, getImageDimensions: () => null,
            WebDAVAPI: class { async putFile() {} }, endUpload: async () => {},
            createResponse: (body, options) => new Response(body, options),
        });
        const form = new FormData();
        form.set('file', new File(['content'], 'file.png', { type: 'image/png' }));
        const response = await route.onRequest({ env, waitUntil() {}, request: new Request('https://img.example/upload?uploadChannel=webdav', { method: 'POST', body: form }) });
        assert.equal(response.status, 200, await response.clone().text());
        const saved = rows.get('file.png').metadata;
        assert.equal(saved.WebDAVAccountId, await getWebDAVAccountId(channel));
        assert.equal(saved.WebDAVPassword, undefined);
        assert.equal(saved.WebDAVUsername, undefined);
    });

    it('rejects a WebDAV account replacement rather than erasing old credentials', async () => {
        const metadata = { Channel: 'WebDAV', ChannelName: 'dav', WebDAVBaseUrl: 'https://dav.example/root', WebDAVUsername: 'alice', WebDAVPassword: 'alice-secret' };
        const { env, rows, db } = fixture({ webdav: { channels: [{ name: 'dav', baseUrl: metadata.WebDAVBaseUrl, username: 'bob', password: 'bob-secret' }] } }, metadata);
        await assert.rejects(db.put('file.png', '', { metadata: { ...metadata, Tags: ['new'] } }), /restore its matching storage channel/);
        assert.deepEqual(rows.get('file.png').metadata, metadata);
        assert.equal((await resolveWebDAVConfig(env, metadata)).username, 'alice');
    });

    it('preserves a non-secret account binding through password rotation and channel rename', async () => {
        const metadata = { Channel: 'WebDAV', ChannelName: 'dav', WebDAVBaseUrl: 'https://dav.example/root', WebDAVUsername: 'alice', WebDAVPassword: 'old-secret' };
        const channel = { name: 'renamed', baseUrl: metadata.WebDAVBaseUrl, username: 'alice', password: 'new-secret' };
        const { env, rows, db } = fixture({ webdav: { channels: [channel] } }, metadata);
        await db.put('file.png', '', { metadata });
        const persisted = rows.get('file.png').metadata;
        assert.equal(persisted.WebDAVUsername, undefined);
        assert.equal(persisted.WebDAVPassword, undefined);
        assert.equal(persisted.WebDAVAccountId, await getWebDAVAccountId(channel));
        assert.equal((await resolveWebDAVConfig(env, persisted)).password, 'new-secret');
        rows.set('manage@sysConfig@upload', { value: JSON.stringify({ webdav: { channels: [{ ...channel, username: 'bob' }] } }) });
        assert.equal(await resolveWebDAVConfig(env, persisted), null);
    });

    it('binds WebDAV custom authentication headers without persisting them', async () => {
        const channel = { baseUrl: 'https://dav.example/root', headers: { Authorization: 'Bearer account-A' } };
        assert.equal(await getWebDAVAccountId(channel), await getWebDAVAccountId({ ...channel, headers: { authorization: 'Bearer account-A' } }));
        assert.notEqual(await getWebDAVAccountId(channel), await getWebDAVAccountId({ ...channel, headers: { Authorization: 'Bearer account-B' } }));
        assert.notEqual(await getWebDAVAccountId({ password: 'account-A-token' }), await getWebDAVAccountId({ password: 'account-B-token' }));
    });

    it('also persists only the hashed WebDAV account identity in D1', async () => {
        let bound;
        const db = new D1Database({ prepare() { return { bind(...args) { return {
            async first() { return null; }, async run() { bound = args; },
        }; } }; } });
        db.get = async () => JSON.stringify({ webdav: { channels: [{
            baseUrl: 'https://dav.example/root', username: 'alice', password: 'password',
        }] } });
        await db.putFile('file.png', '', { metadata: {
            Channel: 'WebDAV', WebDAVBaseUrl: 'https://dav.example/root', WebDAVUsername: 'alice', WebDAVPassword: 'password',
        } });
        const saved = JSON.parse(bound[2]);
        assert.equal(saved.WebDAVAccountId, await getWebDAVAccountId({ username: 'alice', password: 'password' }));
        assert.equal(saved.WebDAVUsername, undefined);
        assert.equal(saved.WebDAVPassword, undefined);
    });

    for (const pair of [
        { accessKeyId: 'new-id', secretAccessKey: '' },
        { accessKeyId: '', secretAccessKey: 'new-secret' },
        { accessKeyId: '', secretAccessKey: '' },
        { accessKeyId: 'new-id', secretAccessKey: 'new-secret' },
    ]) {
        it(`selects an entire S3 credential pair (configured fields: ${Boolean(pair.accessKeyId)}/${Boolean(pair.secretAccessKey)})`, async () => {
            const metadata = { Channel: 'S3', ChannelName: 's3', S3Endpoint: 'https://s3.example', S3BucketName: 'A', S3AccessKeyId: 'old-id', S3SecretAccessKey: 'old-secret' };
            const { env } = fixture({ s3: { channels: [{ name: 's3', endpoint: metadata.S3Endpoint, bucketName: 'A', ...pair }] } }, metadata);
            const result = await hydrateFileCredentials(env, metadata);
            const complete = Boolean(pair.accessKeyId && pair.secretAccessKey);
            assert.equal(result.S3AccessKeyId, complete ? 'new-id' : 'old-id');
            assert.equal(result.S3SecretAccessKey, complete ? 'new-secret' : 'old-secret');
        });
    }
});
