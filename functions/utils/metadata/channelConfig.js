/**
 * 渠道配置匹配工具
 * 负责从当前上传配置中定位历史文件 metadata 对应的渠道配置
 */
import { getUploadConfig } from '../../api/manage/sysConfig/upload.js';
import { getWebDAVAccountId, getMetadataWebDAVAccountId } from './webdavIdentity.js';

// 旧 metadata 中可能保存过渠道身份字段，按强匹配到弱匹配依次尝试
const CHANNEL_IDENTITY_RULES = {
  telegram: [
    [['botId', 'TgBotId'], ['chatId', 'TgChatId']],
    [
      ['botToken', 'TgBotToken'],
      ['chatId', 'TgChatId'],
    ],
  ],
  s3: [
    [
      ['accessKeyId', 'S3AccessKeyId'],
      ['endpoint', 'S3Endpoint'],
      ['bucketName', 'S3BucketName'],
    ],
    [
      ['endpoint', 'S3Endpoint'],
      ['bucketName', 'S3BucketName'],
      ['pathStyle', 'S3PathStyle'],
    ],
    [
      ['endpoint', 'S3Endpoint'],
      ['bucketName', 'S3BucketName'],
    ],
  ],
  discord: [
    [
      ['botToken', 'DiscordBotToken'],
      ['channelId', 'DiscordChannelId'],
    ],
    [['channelId', 'DiscordChannelId']],
  ],
  huggingface: [
    [
      ['repo', 'HfRepo'],
      ['isPrivate', 'HfIsPrivate'],
    ],
    [
      ['repo', 'HfRepo'],
    ],
  ],
  webdav: [
    [
      ['baseUrl', 'WebDAVBaseUrl'],
      ['username', 'WebDAVUsername'],
    ],
    [
      ['baseUrl', 'WebDAVBaseUrl'],
    ],
  ],
};

const URL_IDENTITY_FIELDS = new Set([
  'endpoint',
  'S3Endpoint',
  'baseUrl',
  'WebDAVBaseUrl',
]);

const BOOLEAN_IDENTITY_FIELDS = new Set([
  'pathStyle',
  'S3PathStyle',
  'isPrivate',
  'HfIsPrivate',
]);

/* ========== 主要函数 ========== */

// 加载上传渠道配置，失败时返回 null 并记录上下文
export async function loadChannelConfig(db, env, logContext = 'channel config') {
  try {
    return await getUploadConfig(db, env);
  } catch (error) {
    console.warn(`Failed to load upload config for ${logContext}:`, error.message);
    return null;
  }
}

// 根据 ChannelName、历史身份字段和旧 Telegram 默认名查找匹配渠道
export async function findConfiguredChannel(uploadConfig, groupName, metadata = {}) {
  if (!uploadConfig) return null;
  if (groupName === 'telegram' && !metadata.TgBotId && metadata.TgBotToken) {
    metadata = { ...metadata, TgBotId: String(metadata.TgBotToken).match(/^(\d+):/)?.[1] };
  }

  let channels = (uploadConfig[groupName]?.channels || []).map(channel => groupName === 'telegram'
    ? { ...channel, botId: String(channel.botToken || '').match(/^(\d+):/)?.[1] || '' }
    : channel);
  if (groupName === 'webdav') {
    const expectedAccount = await getMetadataWebDAVAccountId(metadata);
    if (expectedAccount) {
      const accounts = await Promise.all(channels.map(channel => getWebDAVAccountId(channel)));
      channels = channels.filter((channel, index) => accounts[index] === expectedAccount);
    }
  }
  // 优先使用当前版本写入的渠道名，避免多渠道配置相似时误匹配
  if (metadata?.ChannelName) {
    const namedChannel = channels.find((channel) => channel.name === metadata.ChannelName);
    if (namedChannel && channelIdentityMatches(namedChannel, groupName, metadata)) return namedChannel;
  }

  const identityChannel = findChannelByPersistedIdentity(channels, groupName, metadata);
  if (identityChannel) return identityChannel;

  return findLegacyTelegramEnvChannel(channels, groupName, metadata);
}

/* ========== 关键函数 ========== */

// 兼容旧版默认 Telegram 环境变量渠道
function findLegacyTelegramEnvChannel(channels, groupName, metadata = {}) {
  // 兼容未写入 ChannelName 的旧 Telegram 记录
  if (groupName === 'telegram' && !metadata.ChannelName && !metadata.TgBotId && !metadata.TgBotToken && !metadata.TgChatId) {
    return channels.find((channel) => channel.name === 'Telegram_env') || null;
  }

  return null;
}

// 使用 metadata 中残留的身份字段反向匹配当前渠道配置
function findChannelByPersistedIdentity(channels, groupName, metadata = {}) {
  const ruleGroups = CHANNEL_IDENTITY_RULES[groupName] || [];

  for (const fields of ruleGroups) {
    if (!hasAllMetadataFields(metadata, fields)) continue;

    const matches = channels.filter((channel) => fieldsMatch(channel, metadata, fields) && channelIdentityMatches(channel, groupName, metadata));
    if (matches.length === 1) {
      return matches[0];
    }
  }

  return null;
}

// A display name is not a storage identity. Never rebind an old file to another
// bucket, repository, chat or WebDAV root when a channel is edited or reused.
function channelIdentityMatches(channel, group, metadata) {
  const identities = {
    s3: [['endpoint', 'S3Endpoint'], ['bucketName', 'S3BucketName']],
    telegram: [['botId', 'TgBotId'], ['chatId', 'TgChatId']],
    discord: [['channelId', 'DiscordChannelId']],
    huggingface: [['repo', 'HfRepo']],
    webdav: [['baseUrl', 'WebDAVBaseUrl']],
  }[group] || [];
  const historical = { ...metadata };
  if (group === 'telegram' && !historical.TgBotId && historical.TgBotToken) {
    historical.TgBotId = String(historical.TgBotToken).match(/^(\d+):/)?.[1];
  }
  return identities.every(([field, key]) => !hasIdentityValue(historical[key]) ||
    normalizeIdentityValue(channel[field] ?? '', field) === normalizeIdentityValue(historical[key], key));
}

// 确保某组匹配规则所需的 metadata 字段都存在
function hasAllMetadataFields(metadata, fields) {
  return fields.every(([, metadataKey]) => hasIdentityValue(metadata?.[metadataKey]));
}

// 比较渠道配置字段与 metadata 字段是否规范化后一致
function fieldsMatch(channel, metadata, fields) {
  return fields.every(([channelKey, metadataKey]) => {
    const channelValue = channel?.[channelKey];
    const metadataValue = metadata?.[metadataKey];

    if (!hasIdentityValue(channelValue) || !hasIdentityValue(metadataValue)) {
      return false;
    }

    return normalizeIdentityValue(channelValue, channelKey) === normalizeIdentityValue(metadataValue, metadataKey);
  });
}

/* ========== 工具函数 ========== */

// 判断身份字段是否可参与匹配
function hasIdentityValue(value) {
  return value !== undefined && value !== null && value !== '';
}

// 根据字段类型规范化比较值
function normalizeIdentityValue(value, fieldName = '') {
  const text = String(value).trim();

  // URL 与布尔值需要规范化后再比较，避免协议、斜杠或类型差异导致匹配失败
  if (URL_IDENTITY_FIELDS.has(fieldName)) {
    return normalizeUrlIdentityValue(text);
  }

  if (BOOLEAN_IDENTITY_FIELDS.has(fieldName)) {
    return normalizeBooleanIdentityValue(value);
  }

  return text;
}

// 将布尔身份字段统一成字符串形式
function normalizeBooleanIdentityValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim().toLowerCase() === 'true' ? 'true' : 'false';
}

// Preserve protocol and query (they can identify a different storage target).
// Only userinfo, fragments and trailing slashes are irrelevant to matching.
function normalizeUrlIdentityValue(value) {
  try {
    const url = new URL(ensureUrlProtocol(value));
    url.username = '';
    url.password = '';
    url.hash = '';
    if (url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '/');
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return value.replace(/\/+$/, '');
  }
}

// 为缺少协议的地址补充默认协议，便于 URL 解析
function ensureUrlProtocol(value) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    return value;
  }

  return `https://${value}`;
}
