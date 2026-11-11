// Dashboard folder operations need one Worker request per D1 page. Keep the
// fetchWithAuth abstraction so cookies, tokens and session handling stay intact.
globalThis.__imgbedFolderMutation = async function (fetchWithAuth, path, options) {
    const url = new URL(path, location.origin);
    if (url.searchParams.get('folder') !== 'true') return fetchWithAuth(path, options);
    url.searchParams.set('paged', '1');
    const seen = new Set();
    const processed = [], deleted = [], failed = [], warnings = [];
    const result = (status, error) => new Response(JSON.stringify({
        success: status === 200, processed, deleted, failed, warnings, ...(error ? { error } : {}),
    }), { status, headers: { 'Content-Type': 'application/json' } });
    for (let page = 0; page < 10000; page++) {
        const response = await fetchWithAuth(url.pathname + url.search, options);
        if (!response.ok) return response;
        const data = await response.json();
        if (data.success !== true) return result(409, data.error || 'Folder operation failed');
        processed.push(...(data.processed || []));
        deleted.push(...(data.deleted || []));
        failed.push(...(data.failed || []));
        warnings.push(...(data.warnings || []));
        if (!data.nextCursor) return failed.length || warnings.length
            ? result(409, 'Some files were not fully processed; refresh and inspect the folder') : result(200);
        if (typeof data.nextCursor !== 'string' || seen.has(data.nextCursor)) return result(502, 'Invalid folder continuation');
        seen.add(data.nextCursor);
        url.searchParams.set('cursor', data.nextCursor);
    }
    return result(409, 'Folder is too large for one browser operation; refresh and continue');
};
