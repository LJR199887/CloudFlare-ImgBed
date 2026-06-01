import { getCleanupConfig, getCleanupStatus, runCleanup } from '../../functions/utils/cleanupManager.js';

const CHECK_INTERVAL_MS = 60 * 1000;

export function startCleanupScheduler({ createEnv, port }) {
    let timer = null;
    let running = false;

    async function tick() {
        if (running) return;

        running = true;
        try {
            const env = createEnv();
            const config = await getCleanupConfig(env);
            if (!config.enabled) return;

            const status = await getCleanupStatus(env);
            const nextRunAt = status.nextRunAt ? Date.parse(status.nextRunAt) : 0;
            if (nextRunAt && Date.now() < nextRunAt) return;

            const result = await runCleanup({
                env,
                waitUntil: promise => {
                    if (promise && typeof promise.catch === 'function') {
                        promise.catch(err => console.error('cleanup waitUntil error:', err));
                    }
                },
                request: new Request(`http://localhost:${port}/api/manage/cleanup`),
            }, {
                origin: `http://localhost:${port}`,
            });

            console.log('[cleanup] completed:', JSON.stringify({
                success: result.success,
                dryRun: result.dryRun,
                scanned: result.scanned,
                matched: result.matched,
                deleted: result.deleted,
                failed: result.failed,
            }));
        } catch (error) {
            console.error('[cleanup] scheduler error:', error);
        } finally {
            running = false;
        }
    }

    timer = setInterval(tick, CHECK_INTERVAL_MS);
    setTimeout(tick, 10 * 1000);
    console.log('[cleanup] scheduler started');

    return () => {
        if (timer) clearInterval(timer);
        timer = null;
    };
}
