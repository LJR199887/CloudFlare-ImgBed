/**
 * BatchIndexFinalizeAPI - 完成索引重建，组装所有分块
 * 
 * 实现分块组装逻辑，将所有分块合并为完整索引
 * 更新索引元数据
 * 清理临时分块数据
 */

import { getDatabase, checkDatabaseConfig } from '../../../../utils/databaseAdapter.js';
import { stripSensitiveMetadata } from '../../../../utils/metadata/metadataSecurity.js';
import { readKVMutationStates, compactKVMutationStates,
  matchesKVMutationStates } from '../../../../utils/kvIndexMutationState.js';

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// 索引存储键
const INDEX_KEY = 'manage@index';
const INDEX_META_KEY = 'manage@index@meta';
// D1 单字段限制 2MB，KV 限制 25MB，根据数据库类型动态设置
const INDEX_CHUNK_SIZE_D1 = 500; // D1 数据库分块大小
const INDEX_CHUNK_SIZE_KV = 5000; // KV 存储分块大小

/**
 * 根据数据库类型获取索引分块大小
 * @param {Object} env - 环境变量
 * @returns {number} 分块大小
 */
function getIndexChunkSize(env) {
  const config = checkDatabaseConfig(env);
  return config.usingD1 ? INDEX_CHUNK_SIZE_D1 : INDEX_CHUNK_SIZE_KV;
}

/**
 * 创建 JSON 响应
 * @param {Object} data - 响应数据
 * @param {number} status - HTTP 状态码
 * @returns {Response}
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

/**
 * 创建错误响应
 * @param {string} message - 错误消息
 * @param {number} status - HTTP 状态码
 * @param {string} details - 详细错误信息（可选）
 * @returns {Response}
 */
function errorResponse(message, status = 400, details = null) {
  const responseData = { success: false, error: message };
  if (details) {
    responseData.details = details;
  }
  return jsonResponse(responseData, status);
}

/**
 * 验证 sessionId 格式
 * 格式: rebuild_{timestamp}_{randomString}
 * @param {string} sessionId - 会话 ID
 * @returns {boolean}
 */
function isValidSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return false;
  }
  // 限制长度防止过长的 key
  if (sessionId.length > 100) {
    return false;
  }
  // 只允许字母、数字、下划线和连字符
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  return validPattern.test(sessionId);
}

/**
 * 验证请求体数据结构
 * @param {Object} body - 请求体
 * @returns {{valid: boolean, error?: string}}
 */
function validateRequestBody(body) {
  // 检查必需字段
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  // 验证 sessionId
  if (!isValidSessionId(body.sessionId)) {
    return { valid: false, error: 'sessionId must be a valid alphanumeric string' };
  }

  // 验证 totalChunks
  if (typeof body.totalChunks !== 'number' || !Number.isInteger(body.totalChunks) || body.totalChunks < 0) {
    return { valid: false, error: 'totalChunks must be a non-negative integer' };
  }

  // 验证 totalFiles
  if (typeof body.totalFiles !== 'number' || !Number.isInteger(body.totalFiles) || body.totalFiles < 0) {
    return { valid: false, error: 'totalFiles must be a non-negative integer' };
  }

  // checksum 是可选的，但如果提供了必须是有效的字符串
  if (body.checksum !== undefined && body.checksum !== null) {
    if (typeof body.checksum !== 'string') {
      return { valid: false, error: 'checksum must be a string if provided' };
    }
  }

  return { valid: true };
}

/**
 * 验证 KV 暂存分块；索引本身始终从当前数据库记录构建。
 * @param {Object} db - 数据库实例
 * @param {string} sessionId - 会话 ID
 * @param {number} totalChunks - 总分块数
 * @returns {Promise<{success: boolean, error?: string, missingChunks?: Array}>}
 */
async function readAllChunks(db, sessionId, totalChunks) {
  const missingChunks = [];
  const stagedIds = new Set();

  // 读取所有分块 (0 到 totalChunks-1)
  for (let chunkId = 0; chunkId < totalChunks; chunkId++) {
    const chunkKey = `chunk_${sessionId}_${chunkId}`;
    
    try {
      const chunkDataStr = await db.get(chunkKey);
      
      if (!chunkDataStr) {
        missingChunks.push(chunkId);
        continue;
      }

      const chunkData = JSON.parse(chunkDataStr);
      
      // 验证分块数据结构
      if (!chunkData || !Array.isArray(chunkData.data)) {
        missingChunks.push(chunkId);
        continue;
      }
      for (const file of chunkData.data) {
        if (typeof file?.id !== 'string' || !file.id) {
          missingChunks.push(chunkId);
          break;
        }
        stagedIds.add(file.id);
      }

    } catch (error) {
      console.error(`Error reading chunk ${chunkId}:`, error);
      missingChunks.push(chunkId);
    }
  }

  if (missingChunks.length > 0) {
    return {
      success: false,
      error: `Missing chunks: ${missingChunks.join(', ')}`,
      missingChunks,
    };
  }

  return { success: true, stagedIds };
}

async function readCanonicalFiles(db) {
  const files = [];
  let cursor = null;
  // D1 Free permits 50 binding calls per invocation. A larger D1 page keeps
  // ordinary six-figure galleries below that budget; KV list caps at 1000.
  const limit = typeof db.listPendingIndexOperations === 'function' ? 4000 : 1000;
  do {
    const page = await db.list({ limit, cursor });
    if (!Array.isArray(page?.keys)) throw new Error('Database list failed during index rebuild');
    if (page.list_complete === false && !page.cursor) throw new Error('Database list returned an incomplete page without a cursor');
    for (const item of page.keys) {
      if (item.name.startsWith('manage@') || item.name.startsWith('chunk_') || !item.metadata?.TimeStamp) continue;
      files.push({ id: item.name, metadata: item.metadata });
    }
    if (page.cursor === cursor && cursor !== null) throw new Error('Database cursor did not advance');
    cursor = page.cursor || null;
  } while (cursor);
  files.sort((a, b) => (b.metadata.TimeStamp || 0) - (a.metadata.TimeStamp || 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return files;
}

async function verifyKVFiles(db, files) {
  // KV list() and getWithMetadata() may observe different revisions. Never
  // acknowledge a rebuild based on a known-inconsistent snapshot. The bulk
  // API keeps this bounded to one read per 100 file IDs in real Workers KV.
  for (let i = 0; i < files.length; i += 100) {
    const page = files.slice(i, i + 100);
    const current = new Map((await db.getIndexFiles(page.map(file => file.id)))
      .map(file => [file.id, file.metadata]));
    if (page.some(file => !current.has(file.id)
      || JSON.stringify(current.get(file.id)) !== JSON.stringify(file.metadata))) {
      const error = new Error('KV file listing changed or is stale; retry the rebuild after KV propagation');
      error.status = 409;
      throw error;
    }
  }
}

/**
 * 保存分块索引到数据库
 * @param {Object} db - 数据库实例
 * @param {Array} files - 文件记录数组
 * @param {Object} env - 环境变量
 * @returns {Promise<{success: boolean, metadata?: Object, error?: string}>}
 */
async function saveIndex(db, files, env, expected, rebuildChunks = [], appliedOperationIds = [], mutationStates = []) {
  try {
    files = files.map(file => ({ ...file, metadata: stripSensitiveMetadata(file.metadata) }));
    const chunkSize = getIndexChunkSize(env);
    const chunks = [];
    
    // 将文件数组分块
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      chunks.push(chunk);
    }

    // 计算各渠道容量统计
    const channelStats = {};
    let totalSizeMB = 0;

    for (const file of files) {
      const channelName = file.metadata?.ChannelName;
      const fileSize = parseFloat(file.metadata?.FileSize) || 0;

      totalSizeMB += fileSize;

      if (channelName) {
        if (!channelStats[channelName]) {
          channelStats[channelName] = { usedMB: 0, fileCount: 0 };
        }
        channelStats[channelName].usedMB += fileSize;
        channelStats[channelName].fileCount += 1;
      }
    }

    const lastUpdated = Date.now();

    // 保存索引元数据
    const metadata = {
      lastUpdated,
      totalCount: files.length,
      totalSizeMB: Math.round(totalSizeMB * 100) / 100,
      channelStats,
      lastOperationId: null, // 重建后清除操作 ID
      ...(expected === undefined ? { appliedOperationIds: appliedOperationIds.slice(-10000), mutationStates } : {}),
      chunkCount: chunks.length,
      chunkSize: chunkSize,
    };

    if (expected !== undefined) {
      if (!await db.writeIndexSnapshot(metadata, chunks, expected, [], rebuildChunks)) {
        return { success: false, conflict: true, error: 'Index changed while the rebuild was being finalized; retry' };
      }
      return { success: true, metadata };
    }

    await db.put(INDEX_META_KEY, JSON.stringify(metadata));

    // 保存各个分块
    const savePromises = chunks.map((chunk, chunkId) => {
      const chunkKey = `${INDEX_KEY}_${chunkId}`;
      return db.put(chunkKey, JSON.stringify(chunk));
    });

    await Promise.all(savePromises);

    console.log(`Saved index: ${chunks.length} chunks, ${files.length} total files, ${totalSizeMB.toFixed(2)} MB`);

    return { success: true, metadata };
  } catch (error) {
    console.error('Error saving index:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 清理临时分块数据
 * @param {Object} db - 数据库实例
 * @param {string} sessionId - 会话 ID
 * @param {number} totalChunks - 总分块数
 * @returns {Promise<void>}
 */
async function cleanupChunks(db, sessionId, totalChunks) {
  const deletePromises = [];

  for (let chunkId = 0; chunkId < totalChunks; chunkId++) {
    const chunkKey = `chunk_${sessionId}_${chunkId}`;
    deletePromises.push(
      db.delete(chunkKey).catch(error => {
        console.warn(`Failed to delete chunk ${chunkKey}:`, error);
      })
    );
  }

  await Promise.all(deletePromises);
  console.log(`Cleaned up ${totalChunks} temporary chunks for session ${sessionId}`);
}

/**
 * 处理 POST 请求 - 完成索引重建
 * 
 * @param {Object} context - Cloudflare Workers 上下文
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 认证已由 _middleware.js 处理

    // 解析请求体
    let body;
    try {
      body = await request.json();
    } catch (parseError) {
      return errorResponse('Invalid JSON in request body', 400);
    }

    // 验证请求体数据结构
    const validation = validateRequestBody(body);
    if (!validation.valid) {
      return errorResponse('Invalid request body', 400, validation.error);
    }

    const { sessionId, totalChunks, totalFiles } = body;

    // 4. 获取数据库实例
    const db = getDatabase(env);
    const atomic = typeof db.writeIndexSnapshot === 'function' && typeof db.db.batch === 'function';
    const expected = atomic ? await db.get(INDEX_META_KEY) : undefined;
    const oldMeta = !atomic ? await db.get(INDEX_META_KEY) : null;
    let appliedOperationIds = [];
    let mutationStates = [];
    if (oldMeta) {
      let previous = null;
      try {
        previous = JSON.parse(oldMeta);
      } catch (_) { /* Rebuilds also repair corrupt metadata. */ }
      if (previous) {
        const ids = previous.appliedOperationIds;
        if (Array.isArray(ids)) appliedOperationIds = ids.filter(id => typeof id === 'string').slice(-10000);
        mutationStates = compactKVMutationStates(readKVMutationStates(previous));
      }
    }

    if (atomic) {
      // Browser staging may be older than a deletion whose queue entry was
      // already acknowledged. Build from the authoritative D1 file table,
      // not from that stale snapshot. The CAS protects the scan against a
      // concurrent index merge; later file mutations remain queued.
      if (typeof db.listRebuildChunkIds !== 'function') throw new Error('D1 rebuild staging API unavailable');
      const staged = new Set(await db.listRebuildChunkIds(sessionId));
      const missing = Array.from({ length: totalChunks }, (_, i) => i)
        .filter(i => !staged.has(`chunk_${sessionId}_${i}`));
      if (missing.length) return errorResponse('Failed to read chunks', 400, `Missing chunks: ${missing.join(', ')}`);
      const files = await readCanonicalFiles(db);
      const stagedKeys = Array.from({ length: totalChunks }, (_, i) => `chunk_${sessionId}_${i}`);
      const saved = await saveIndex(db, files, env, expected, stagedKeys);
      if (!saved.success) return errorResponse('Failed to save index', saved.conflict ? 409 : 500, saved.error);
      // The snapshot and temporary-row cleanup commit in one D1 transaction.
      return jsonResponse({ success: true, indexedCount: files.length, lastUpdated: saved.metadata.lastUpdated });
    }

    // KV also must not republish a browser snapshot that predates a delete.
    // Its staging cannot provide an atomic snapshot, so validate presence and
    // reconstruct from the live records instead. Pending operations remain.
    const chunksResult = await readAllChunks(db, sessionId, totalChunks);
    if (!chunksResult.success) return errorResponse('Failed to read chunks', 400, chunksResult.error);
    const allFiles = await readCanonicalFiles(db);
    await verifyKVFiles(db, allFiles);
    if (!matchesKVMutationStates(allFiles, readKVMutationStates({ mutationStates }))) {
      return errorResponse('KV listing conflicts with recent index mutations; retry after propagation', 409);
    }
    // If the client scan and server scan disagree, the KV view is unstable.
    // Do not publish either snapshot or consume the staging session.
    const currentIds = new Set(allFiles.map(file => file.id));
    if (currentIds.size !== chunksResult.stagedIds.size
      || [...currentIds].some(id => !chunksResult.stagedIds.has(id))) {
      return errorResponse('KV files changed while rebuilding; retry after KV propagation', 409);
    }

    // 8. 验证文件数量
    if (allFiles.length !== totalFiles) {
      return errorResponse('KV file count changed while rebuilding; retry', 409,
        `Expected ${totalFiles}, found ${allFiles.length}`);
    }
    if (await db.get(INDEX_META_KEY) !== oldMeta) {
      return errorResponse('KV index changed while rebuilding; retry', 409);
    }

    // 保存新索引
    const saveResult = await saveIndex(db, allFiles, env, expected, [], appliedOperationIds, mutationStates);
    if (!saveResult.success) {
      return errorResponse('Failed to save index', saveResult.conflict ? 409 : 500, saveResult.error);
    }
    // KV has no conditional delete: deleting an old chunk here could erase a
    // newer concurrent index. Extra keys above chunkCount are inert.

    // 清理临时分块数据
    // 使用 waitUntil 异步清理，不阻塞响应
    if (context.waitUntil) {
      context.waitUntil(cleanupChunks(db, sessionId, totalChunks));
    } else {
      await cleanupChunks(db, sessionId, totalChunks);
    }

    // 返回成功响应
    return jsonResponse({
      success: true,
      indexedCount: allFiles.length,
      lastUpdated: saveResult.metadata.lastUpdated,
    });

  } catch (error) {
    console.error('Error in BatchIndexFinalizeAPI:', error);
    if (error.status === 409) return errorResponse(error.message, 409);
    return errorResponse(`Server error: ${error.message}`, 500);
  }
}

/**
 * 处理 OPTIONS 请求 - CORS 预检
 * 
 * @returns {Response}
 */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * 默认请求处理器
 * 
 * @param {Object} context - Cloudflare Workers 上下文
 * @returns {Promise<Response>}
 */
export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'POST') {
    return onRequestPost(context);
  }

  if (request.method === 'OPTIONS') {
    return onRequestOptions();
  }

  return errorResponse('Method not allowed', 405);
}
