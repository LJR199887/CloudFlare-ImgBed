import { BACKUP_SETTING_KEYS } from '../../../utils/backupSettings.js';
/**
 * BatchSettingsAPI - 批量读取系统设置的 API 端点
 * 
 * 读取允许备份的系统设置
 * 用于备份功能获取系统设置数据
 */

import { getDatabase } from '../../../utils/databaseAdapter.js';

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

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
 * @returns {Response}
 */
function errorResponse(message, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

/**
 * 从键名中移除 manage@ 前缀
 * 
 * @param {string} key - 完整的 KV 键名
 * @returns {string} 移除前缀后的键名
 */
function stripManagePrefix(key) {
  const prefix = 'manage@';
  if (key.startsWith(prefix)) {
    return key.slice(prefix.length);
  }
  return key;
}

/**
 * 处理 GET 请求 - 读取所有系统设置
 * 
 * @param {Object} context - Cloudflare Workers 上下文
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const { env } = context;

  try {
    // 获取数据库实例（认证已由 _middleware.js 处理）
    const db = getDatabase(env);

    const settings = {};
    // Do not enumerate runtime keys: thousands of session or index records
    // must not hide configuration keys behind the adapter's list limit.
    for (const key of BACKUP_SETTING_KEYS) {
      const value = await db.get(key);
      if (value == null) continue;
      let parsedValue;
      try { parsedValue = JSON.parse(value); }
      catch { parsedValue = value; }
      if (key === 'manage@sysConfig@security' && parsedValue && typeof parsedValue === 'object') delete parsedValue.sessionEpochs;
      settings[stripManagePrefix(key)] = parsedValue;
    }

    // 4. 返回成功响应
    return jsonResponse({
      success: true,
      settings,
    });

  } catch (error) {
    console.error('Error in BatchSettingsAPI:', error);
    return errorResponse(`Database read error: ${error.message}`, 500);
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
  
  if (request.method === 'GET') {
    return onRequestGet(context);
  }
  
  if (request.method === 'OPTIONS') {
    return onRequestOptions();
  }
  
  return errorResponse('Method not allowed', 405);
}
