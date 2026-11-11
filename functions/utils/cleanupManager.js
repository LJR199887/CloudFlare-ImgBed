import { deleteFile } from '../api/manage/delete/[[path]].js';
import { batchRemoveFilesFromIndex, mergeOperationsToIndex } from './indexManager.js';
import { getDatabase } from './databaseAdapter.js';

const CONFIG_KEY = 'manage@sysConfig@cleanup';
const STATUS_KEY = 'manage@sysConfig@cleanupStatus';
const MAX_LOG_ENTRIES = 30;
// Allow the most expensive storage channel to finish each claimed deletion,
// including the database delete, cache config, claim release, and final status.
const MAX_WORKER_D1_DELETIONS = 4;
const DEFAULT_CONFIG = {
    enabled: false,
    dryRun: true,
    retentionDays: 180,
    batchSize: 500,
    intervalHours: 24,
    excludeDirs: '',
    excludeTags: '',
    keepWhiteList: true,
};

function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(Math.trunc(number), min), max);
}

function splitList(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }
    return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeDir(dir) {
    let value = String(dir || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (value && !value.endsWith('/')) value += '/';
    return value;
}

export function normalizeCleanupConfig(config = {}) {
    return {
        enabled: config.enabled === true,
        dryRun: config.dryRun !== false,
        retentionDays: clampNumber(config.retentionDays, DEFAULT_CONFIG.retentionDays, 1, 3650),
        batchSize: clampNumber(config.batchSize, DEFAULT_CONFIG.batchSize, 1, 5000),
        intervalHours: clampNumber(config.intervalHours, DEFAULT_CONFIG.intervalHours, 1, 24 * 30),
        excludeDirs: splitList(config.excludeDirs).map(normalizeDir).filter(Boolean).join(','),
        excludeTags: splitList(config.excludeTags).join(','),
        keepWhiteList: config.keepWhiteList !== false,
    };
}

export async function getCleanupConfig(env) {
    const db = getDatabase(env);
    const configStr = await db.get(CONFIG_KEY);
    const stored = configStr ? JSON.parse(configStr) : {};
    return normalizeCleanupConfig({ ...DEFAULT_CONFIG, ...stored });
}

export async function saveCleanupConfig(env, config) {
    const db = getDatabase(env);
    const normalized = normalizeCleanupConfig({ ...DEFAULT_CONFIG, ...config });
    await db.put(CONFIG_KEY, JSON.stringify(normalized));
    return normalized;
}

export async function getCleanupStatus(env) {
    const db = getDatabase(env);
    const statusStr = await db.get(STATUS_KEY);
    const status = statusStr ? JSON.parse(statusStr) : {
        running: false,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastResult: null,
        nextRunAt: null,
    };
    return sanitizeStatus(status);
}

export async function saveCleanupStatus(env, status) {
    const db = getDatabase(env);
    const sanitized = sanitizeStatus(status);
    await db.put(STATUS_KEY, JSON.stringify(sanitized));
    return sanitized;
}

function summarizeResult(result) {
    if (!result || typeof result !== 'object') return result;
    const { deletedFiles, failedFiles, ...summary } = result;
    summary.deleted = Number(summary.deleted ?? deletedFiles?.length ?? 0);
    summary.failed = Number(summary.failed ?? failedFiles?.length ?? 0);
    return summary;
}

function sanitizeStatus(status) {
    if (!status || typeof status !== 'object') return status;
    return {
        ...status,
        lastResult: summarizeResult(status.lastResult),
        logs: Array.isArray(status.logs) ? status.logs.map(summarizeResult).slice(0, MAX_LOG_ENTRIES) : [],
    };
}

function appendCleanupLog(status, result, startedAt, finishedAt) {
    const logs = Array.isArray(status.logs) ? status.logs : [];
    const entry = summarizeResult({
        ...result,
        startedAt,
        finishedAt,
    });
    return [entry, ...logs].slice(0, MAX_LOG_ENTRIES);
}

function shouldSkipRecord(row, config) {
    let metadata;
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { return true; }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return true;
    const excludeDirs = splitList(config.excludeDirs).map(normalizeDir);
    const excludeTags = new Set(splitList(config.excludeTags));
    const directory = normalizeDir(metadata.Directory || row.directory || '');

    if (config.keepWhiteList && metadata.ListType === 'White') return true;
    if (excludeDirs.some(dir => directory === dir || directory.startsWith(dir))) return true;

    const tags = Array.isArray(metadata.Tags) ? metadata.Tags : [];
    if (tags.some(tag => excludeTags.has(String(tag)))) return true;

    return false;
}

async function listExpiredFiles(env, config, cutoff, cursor) {
    if (!env.img_d1 || typeof env.img_d1.prepare !== 'function') {
        throw new Error('Automatic cleanup currently requires the Docker/D1 database adapter.');
    }

    const scanLimit = Math.min(config.batchSize * 5, 10000);
    const base = 'SELECT id, metadata, directory, timestamp FROM files WHERE timestamp < ?';
    const order = ' ORDER BY timestamp ASC, id ASC LIMIT ?';
    const response = cursor
        ? await env.img_d1.prepare(base + ' AND (timestamp, id) > (?, ?)' + order)
            .bind(cutoff, cursor.timestamp, cursor.id, scanLimit).all()
        : await env.img_d1.prepare(base + order).bind(cutoff, scanLimit).all();

    const rows = response.results || [];
    const selected = [];
    let skipped = 0;
    let visited = 0;

    for (const row of rows) {
        visited++;
        if (shouldSkipRecord(row, config)) {
            skipped++;
            continue;
        }
        selected.push(row);
        if (selected.length >= config.batchSize) break;
    }

    return { selected, scanned: rows.length, skipped,
        lastVisited: rows[visited - 1], more: visited < rows.length || rows.length === scanLimit };
}

export async function runCleanup(context, options = {}) {
    const { env } = context;
    if (typeof env.img_d1?.prepare !== 'function' || typeof env.img_url?.get === 'function') {
        return { success: false, error: 'Automatic cleanup requires D1 or Docker SQLite as the primary database' };
    }
    const workerD1 = env.img_d1.isLocalSQLite !== true;
    const config = normalizeCleanupConfig({
        ...await getCleanupConfig(env),
        ...options.config,
    });
    const now = Date.now();
    const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1000;
    const origin = options.origin || 'http://localhost:8080';
    const url = new URL(origin);
    const status = await getCleanupStatus(env);
    const policy = JSON.stringify([config.retentionDays, config.excludeDirs, config.excludeTags, config.keepWhiteList]);
    const savedCursor = status.cleanupCursor;
    let cursor = workerD1 && savedCursor?.policy === policy && Number.isFinite(savedCursor.timestamp)
        && typeof savedCursor.id === 'string' ? savedCursor : null;

    if (status.running && !options.force) {
        return {
            success: false,
            skipped: true,
            reason: 'cleanup already running',
        };
    }

    await saveCleanupStatus(env, {
        ...status,
        running: true,
        lastStartedAt: new Date(now).toISOString(),
    });

    const result = {
        success: true,
        dryRun: config.dryRun,
        retentionDays: config.retentionDays,
        cutoff,
        cutoffISO: new Date(cutoff).toISOString(),
        scanned: 0,
        skipped: 0,
        matched: 0,
        deleted: 0,
        failed: 0,
    };
    const deletedFileIds = [];

    try {
        const expired = await listExpiredFiles(env, config, cutoff, config.dryRun ? null : cursor);
        result.scanned = expired.scanned;
        result.skipped = expired.skipped;
        result.matched = expired.selected.length;

        if (!config.dryRun) {
            const selected = workerD1 ? expired.selected.slice(0, MAX_WORKER_D1_DELETIONS) : expired.selected;
            result.deferred = expired.selected.length - selected.length;
            for (const row of selected) {
                const fileId = row.id;
                const expected = JSON.stringify(JSON.parse(row.metadata || '{}'));
                const cdnUrl = `${url.origin}/file/${fileId}`;
                const ok = await deleteFile(env, fileId, cdnUrl, url, current => JSON.stringify(current.metadata) === expected);
                if (ok) {
                    result.deleted++;
                    deletedFileIds.push(fileId);
                } else {
                    result.failed++;
                }
                if (workerD1) cursor = { policy, timestamp: row.timestamp, id: row.id };
            }
            if (workerD1 && result.deferred === 0) {
                const last = expired.more ? expired.lastVisited : null;
                cursor = last ? { policy, timestamp: last.timestamp, id: last.id } : null;
            }
            if (workerD1) result.hasMore = cursor !== null;

            if (deletedFileIds.length > 0) {
                const indexOperation = await batchRemoveFilesFromIndex(context, deletedFileIds);
                if (indexOperation?.success === false) throw new Error(indexOperation.error || 'Failed to queue index removal');
                // Index rebuild/merge has unbounded query cost. Worker reads
                // already apply pending operations; leave that work out of the
                // destructive invocation and reserve the status write.
                if (workerD1) result.indexUpdatePending = true;
                else await mergeOperationsToIndex(context);
            }
        }

        return result;
    } catch (error) {
        result.success = false;
        result.error = error.message;
        return result;
    } finally {
        const finishedAt = Date.now();
        const startedAtISO = new Date(now).toISOString();
        const finishedAtISO = new Date(finishedAt).toISOString();
        await saveCleanupStatus(env, {
            running: false,
            lastStartedAt: startedAtISO,
            lastFinishedAt: finishedAtISO,
            nextRunAt: new Date(finishedAt + config.intervalHours * 60 * 60 * 1000).toISOString(),
            lastResult: result,
            logs: appendCleanupLog(status, result, startedAtISO, finishedAtISO),
            ...(workerD1 ? { cleanupCursor: cursor } : {}),
        });
    }
}

export { DEFAULT_CONFIG };
