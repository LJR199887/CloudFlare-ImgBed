import {
    getCleanupConfig,
    getCleanupStatus,
    runCleanup,
    saveCleanupConfig,
} from '../../utils/cleanupManager.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request } = context;

    if (request.method === 'GET') {
        const config = await getCleanupConfig(context.env);
        const status = await getCleanupStatus(context.env);
        return json({ config, status });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        const config = await saveCleanupConfig(context.env, body);
        const status = await getCleanupStatus(context.env);
        return json({ config, status });
    }

    if (request.method === 'PUT') {
        const result = await runCleanup(context, {
            force: true,
            origin: new URL(request.url).origin,
        });
        const config = await getCleanupConfig(context.env);
        const status = await getCleanupStatus(context.env);
        return json({ config, status, result });
    }

    return new Response('Method Not Allowed', {
        status: 405,
        headers: corsHeaders,
    });
}

function json(data) {
    return new Response(JSON.stringify(data), {
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
        },
    });
}
