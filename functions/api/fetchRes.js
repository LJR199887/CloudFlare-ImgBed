import { dualAuthCheck } from '../utils/auth/dualAuth.js';
import { applyDownloadPolicy, fetchImportedFile, httpFileUrl, remoteFileName, pickHeaders, DOWNLOAD_RESPONSE_HEADERS } from '../utils/downloadPolicy.js';

export async function onRequest(context) {
    // 获取请求体中URL的内容
    const {
        request,
        env,
        params,
        waitUntil,
        next,
        data
    } = context;

    // 双重鉴权检查
    const url = new URL(request.url);
    const { authorized } = await dualAuthCheck(env, url, request);
    if (!authorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    const targetUrl = httpFileUrl((await request.json().catch(() => null))?.url);
    if (!targetUrl) return new Response('An HTTP(S) file URL without credentials is required', { status: 400 });
    let response;
    try { response = await fetchImportedFile(targetUrl, env); }
    catch { return new Response('Remote download unavailable or destination not allowed', { status: 502 }); }
    const headers = pickHeaders(response.headers, DOWNLOAD_RESPONSE_HEADERS);
    applyDownloadPolicy(headers, headers.get('Content-Type'), remoteFileName(response, targetUrl));
    return new Response(response.body, {
        status: response.status, headers
    })
}
