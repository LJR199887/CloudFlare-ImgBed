import { deleteFile } from '../api/manage/delete/[[path]].js';
import { batchRemoveFilesFromIndex, mergeOperationsToIndex } from './indexManager.js';
import { getDatabase } from './databaseAdapter.js';

const CONFIG_KEY = 'manage@sysConfig@cleanup';
const STATUS_KEY = 'manage@sysConfig@cleanupStatus';
const MAX_LOG_ENTRIES = 30;
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
    const metadata = JSON.parse(row.metadata || '{}');
    const excludeDirs = splitList(config.excludeDirs).map(normalizeDir);
    const excludeTags = new Set(splitList(config.excludeTags));
    const directory = normalizeDir(metadata.Directory || row.directory || '');

    if (config.keepWhiteList && metadata.ListType === 'White') return true;
    if (excludeDirs.some(dir => directory === dir || directory.startsWith(dir))) return true;

    const tags = Array.isArray(metadata.Tags) ? metadata.Tags : [];
    if (tags.some(tag => excludeTags.has(String(tag)))) return true;

    return false;
}

async function listExpiredFiles(env, config, cutoff) {
    if (!env.img_d1 || typeof env.img_d1.prepare !== 'function') {
        throw new Error('Automatic cleanup currently requires the Docker/D1 database adapter.');
    }

    const scanLimit = Math.min(config.batchSize * 5, 10000);
    const response = await env.img_d1.prepare(
        'SELECT id, metadata, directory FROM files WHERE timestamp < ? ORDER BY timestamp ASC LIMIT ?'
    ).bind(cutoff, scanLimit).all();

    const rows = response.results || [];
    const selected = [];
    let skipped = 0;

    for (const row of rows) {
        if (shouldSkipRecord(row, config)) {
            skipped++;
            continue;
        }
        selected.push(row.id);
        if (selected.length >= config.batchSize) break;
    }

    return { selected, scanned: rows.length, skipped };
}

export async function runCleanup(context, options = {}) {
    const { env } = context;
    const config = normalizeCleanupConfig({
        ...await getCleanupConfig(env),
        ...options.config,
    });
    const now = Date.now();
    const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1000;
    const origin = options.origin || 'http://localhost:8080';
    const url = new URL(origin);
    const status = await getCleanupStatus(env);

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
        const expired = await listExpiredFiles(env, config, cutoff);
        result.scanned = expired.scanned;
        result.skipped = expired.skipped;
        result.matched = expired.selected.length;

        if (!config.dryRun) {
            for (const fileId of expired.selected) {
                const cdnUrl = `${url.origin}/file/${fileId}`;
                const ok = await deleteFile(env, fileId, cdnUrl, url);
                if (ok) {
                    result.deleted++;
                    deletedFileIds.push(fileId);
                } else {
                    result.failed++;
                }
            }

            if (deletedFileIds.length > 0) {
                await batchRemoveFilesFromIndex(context, deletedFileIds);
                await mergeOperationsToIndex(context);
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
        });
    }
}

export { DEFAULT_CONFIG };
