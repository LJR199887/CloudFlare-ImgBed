import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { describe, it } from 'node:test';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';

describe('upload MIME integration', () => {
    it('infers a missing MIME type when initializing chunk uploads', async () => {
        const db = memoryDatabase();
        const chunk = await loadFunction('functions/upload/chunkUpload.js', {
            getDatabase: () => db,
            createResponse: (body, options) => new Response(body, options),
            getUploadIp: () => '', getIPAddress: async () => '',
        });
        const form = new FormData();
        form.set('originalFileName', 'PHOTO.PNG');
        form.set('totalChunks', '1');
        const request = new Request('https://img.example/upload?uploadChannel=cfr2', { method: 'POST', body: form });
        const response = await chunk.initializeChunkedUpload({ request, env: { img_url: {} }, url: new URL(request.url) });
        assert.equal(response.status, 200, await response.clone().text());
        const { uploadId } = await response.json();
        assert.equal(JSON.parse(await db.get(`upload_session_${uploadId}`)).originalFileType, 'image/png');
    });

    it('uses inferred MIME for Hugging Face direct-upload naming', async () => {
        let namedType;
        const route = await loadFunction('functions/upload/huggingface/getUploadUrl.js', {
            userAuthCheck: async () => true,
            getUploadIp: () => '', isBlockedUploadIp: async () => false,
            fetchUploadConfig: async () => ({ huggingface: { channels: [{ name: 'hf', token: 'token', repo: 'owner/repo' }] } }),
            buildUniqueFileId: async (context, name, type) => { namedType = type; return name; },
            HuggingFaceAPI: class { async getLfsUploadInfo() { return {}; } },
            createResponse: (body, options) => new Response(body, options),
        });
        const request = new Request('https://img.example/upload/huggingface/getUploadUrl', {
            method: 'POST', body: JSON.stringify({ fileSize: 3, fileName: 'photo.png', fileType: 'application/octet-stream', sha256: 'hash', fileSample: 'sample' }),
        });
        const response = await route.onRequestPost({ request, env: {} });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(namedType, 'image/png');
    });

    for (const [clientType, expected] of [
        ['application/octet-stream', 'image/png'],
        ['application/pdf', 'application/pdf'],
    ]) {
        it(`stores ${expected} and preserves HTTPS upload links`, async () => {
            const db = memoryDatabase();
            let storedType;
            const route = await loadFunction('functions/upload/index.js', {
                getDatabase: () => db,
                fetchSecurityConfig: async () => ({ upload: { moderate: { enabled: false } } }),
                fetchUploadConfig: async () => ({ cfr2: { channels: [{ name: 'R2_env', publicUrl: 'https://cdn.example' }] } }),
                userAuthCheck: async () => true,
                UnauthorizedResponse: () => new Response('Unauthorized', { status: 401 }),
                getUploadIp: () => '', getIPAddress: async () => '',
                isBlockedUploadIp: async () => false,
                sanitizeUploadFolder: value => value,
                resolveFileExt: () => 'png',
                buildUniqueFileId: async () => 'photo.png',
                getImageDimensions: () => null,
                moderateContent: async () => 'None',
                endUpload: async () => {},
                createResponse: (body, options) => new Response(body, options),
            });
            const form = new FormData();
            form.set('file', new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: clientType }));
            const request = new Request('http://img.example/upload?uploadChannel=cfr2&returnFormat=full', {
                method: 'POST', body: form,
            });
            const env = { img_r2: { async put(id, file, options) { storedType = options.httpMetadata.contentType; } } };
            const response = await route.onRequest({ request, env, waitUntil() {} });
            assert.equal(response.status, 200, await response.clone().text());
            assert.equal(storedType, expected);
            assert.equal((await db.getWithMetadata('photo.png')).metadata.FileType, expected);
            assert.equal((await response.json())[0].src, 'https://img.example/file/photo.png');
        });
    }
});
