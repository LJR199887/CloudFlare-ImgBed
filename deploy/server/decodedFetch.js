// Node fetch decodes these encodings but retains the upstream wire headers.
// Normalize only this transport, never Workers fetch or raw http.get streams.
export function createDecodedFetch(fetchImpl) {
    return async (input, init) => {
        const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        // Keep negotiation stable across Node/Undici versions. In particular,
        // Node 22 and 24 differ in whether zstd is automatically decoded.
        // Undici itself appends identity for Range; do not append it twice.
        if (!requestHeaders.has('Accept-Encoding') && !requestHeaders.has('Range')) {
            requestHeaders.set('Accept-Encoding', 'gzip, deflate, br');
        }
        const response = await fetchImpl(input, { ...init, headers: requestHeaders });
        const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const encodings = (response.headers.get('Content-Encoding') || '').toLowerCase().split(',').map(s => s.trim());
        if (method === 'HEAD' || !response.body || encodings.every(s => !s || s === 'identity')) return response;
        if (!encodings.every(s => ['gzip', 'x-gzip', 'deflate', 'br'].includes(s))) {
            await response.body.cancel();
            throw new Error('Unsupported download content encoding');
        }
        // Compressed partial representations have wire-byte offsets, not
        // decoded-byte offsets. Do not advertise them as usable file ranges.
        if (response.status === 206 || response.headers.has('Content-Range')) {
            await response.body.cancel();
            throw new Error('Compressed partial download cannot be relayed safely');
        }
        const headers = new Headers(response.headers);
        headers.delete('Content-Encoding');
        headers.delete('Content-Length');
        const normalized = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        for (const key of ['url', 'redirected', 'type']) Object.defineProperty(normalized, key, { value: response[key] });
        return normalized;
    };
}
