import assert from 'node:assert/strict';
import { it } from 'node:test';
import '../deploy/server/register.mjs';
import { databaseFixture } from './helpers/databaseFixture.js';
import { authenticate, AUTH_SCOPE } from '../functions/utils/auth/authCore.js';
import { userAuthCheck } from '../functions/utils/auth/userAuth.js';

for (const backend of ['KV', 'D1']) {
    it(`${backend}: legacy upload authCode accepts tokens without disabling password protection`, async t => {
        const { env, db } = databaseFixture(t, backend);
        const settings = {
            auth: { admin: { adminUsername: 'admin', adminPassword: 'admin-password' }, user: { authCode: 'upload-password' } },
            apiTokens: { tokens: {
                valid: { token: 'imgbed_fixture', permissions: ['upload'], expiresAt: null },
                expired: { token: 'imgbed_expired', permissions: ['upload'], expiresAt: '2000-01-01T00:00:00.000Z' },
                list: { token: 'imgbed_list', permissions: ['list'] },
                malformed: { token: 'imgbed_malformed', permissions: 'upload' },
            } },
        };
        const save = () => db.put('manage@sysConfig@security', JSON.stringify(settings));
        await save();
        const check = async (credential, headers = {}, path = '/upload') => {
            const url = new URL(path, 'https://img.test');
            if (credential !== undefined) url.searchParams.set('authCode', credential);
            return userAuthCheck(env, url, new Request(url, { method: 'POST', headers }), 'upload');
        };

        for (const path of ['/upload', '/upload/huggingface/getUploadUrl', '/upload/huggingface/commitUpload']) {
            assert.equal(await check('imgbed_fixture', {}, path), true);
        }
        for (const value of [undefined, '', 'wrong', 'imgbed_unknown', 'imgbed_expired', 'imgbed_list', 'imgbed_malformed']) {
            assert.equal(await check(value), false, `reject ${value}`);
        }
        assert.equal(await check('upload-password'), true, 'legacy password still works');
        assert.equal(await check(undefined, { Authorization: 'Bearer imgbed_fixture' }), true);
        assert.equal(await check('wrong', { Authorization: 'Bearer imgbed_fixture' }), true);
        assert.equal(await check('imgbed_fixture', { Authorization: 'Bearer imgbed_expired' }), false);
        assert.equal(await check(undefined, { Referer: 'https://img.test/?authCode=imgbed_fixture' }), false);
        assert.equal(await check(undefined, { Cookie: 'authCode=imgbed_fixture' }), false);

        for (const authScope of Object.values(AUTH_SCOPE)) {
            for (const requiredPermission of [null, 'list', 'manage', 'upload']) {
                if (authScope === AUTH_SCOPE.USER && requiredPermission === 'upload') continue;
                const url = new URL('https://img.test/api/manage/list?authCode=imgbed_fixture');
                const result = await authenticate({ env, url, request: new Request(url), authScope, requiredPermission });
                assert.equal(result.authorized, false, `${authScope}/${requiredPermission}`);
            }
        }

        settings.auth.user.authCode = 'new-upload-password';
        await save();
        assert.equal(await check('imgbed_fixture'), true, 'password changes do not revoke token');
        assert.equal(await check('upload-password'), false);
        assert.equal(await check('new-upload-password'), true);

        delete settings.apiTokens.tokens.valid;
        await save();
        assert.equal(await check('imgbed_fixture'), false, 'revoked token is rejected');
        assert.equal(await check(undefined, { Authorization: 'Bearer imgbed_fixture' }), false);
    });
}
