/**
 * D1 数据库操作工具类
 */
import { prepareMetadataForStorage } from './metadata/webdavIdentity.js';
import { assertLegacyWriteSafe } from './metadata/writeSafety.js';

class D1Database {
    constructor(db, env = {}) {
        this.db = db;
        this.env = env;
    }
}

// ==================== 文件操作 ====================

/**
 * 保存文件记录 (替代 KV.put)
 */
D1Database.prototype.putFile = async function(fileId, value, options) {
    await assertLegacyWriteSafe(this, this.env, fileId, options?.metadata);
    value = value || '';
    options = options || {};
    var metadata = await prepareMetadataForStorage(options.metadata || {});
    
    // 从metadata中提取字段用于索引
    var extractedFields = this.extractMetadataFields(metadata);
    
    var stmt = this.db.prepare(
        'INSERT OR REPLACE INTO files (' +
        'id, value, metadata, file_name, file_type, file_size, ' +
        'upload_ip, upload_address, list_type, timestamp, ' +
        'label, directory, channel, channel_name, ' +
        'tg_file_id, tg_chat_id, tg_bot_token, is_chunked' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    
    return stmt.bind(
        fileId,
        value,
        JSON.stringify(metadata),
        extractedFields.fileName,
        extractedFields.fileType,
        extractedFields.fileSize,
        extractedFields.uploadIP,
        extractedFields.uploadAddress,
        extractedFields.listType,
        extractedFields.timestamp,
        extractedFields.label,
        extractedFields.directory,
        extractedFields.channel,
        extractedFields.channelName,
        extractedFields.tgFileId,
        extractedFields.tgChatId,
        extractedFields.tgBotToken,
        extractedFields.isChunked
    ).run();
};

/**
 * 获取文件记录 (替代 KV.get)
 */
D1Database.prototype.getFile = function(fileId) {
    var self = this;
    var stmt = this.db.prepare('SELECT * FROM files WHERE id = ?');
    return stmt.bind(fileId).first().then(function(result) {
        if (!result) return null;
        
        return {
            value: result.value,
            metadata: JSON.parse(result.metadata || '{}')
        };
    });
};

/**
 * 获取文件记录包含元数据 (替代 KV.getWithMetadata)
 */
D1Database.prototype.getFileWithMetadata = function(fileId) {
    return this.getFile(fileId);
};

D1Database.prototype.getFileValues = async function(ids) {
    const result = await this.db.prepare(`SELECT id, value FROM files WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids).all();
    return new Map((result.results || []).map(row => [row.id, row.value]));
};

/**
 * 删除文件记录 (替代 KV.delete)
 */
D1Database.prototype.deleteFile = function(fileId) {
    var stmt = this.db.prepare('DELETE FROM files WHERE id = ?');
    return stmt.bind(fileId).run();
};

/**
 * 列出文件 (替代 KV.list)
 */
D1Database.prototype.listFiles = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var limit = options.limit || 1000;
    var cursor = options.cursor || null;
    
    var query = 'SELECT id, metadata FROM files';
    var params = [];
    
    if (prefix) {
        query += ' WHERE id LIKE ?';
        params.push(prefix + '%');
    }
    
    if (cursor) {
        query += prefix ? ' AND' : ' WHERE';
        query += ' id > ?';
        params.push(cursor);
    }
    
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        var hasMore = results.length > limit;
        if (hasMore) {
            results.pop();
        }

        var keys = results.map(function(row) {
            return {
                name: row.id,
                metadata: JSON.parse(row.metadata || '{}')
            };
        });
        
        return {
            keys: keys,
            cursor: hasMore && keys.length > 0 ? keys[keys.length - 1].name : null,
            list_complete: !hasMore
        };
    });
};

// ==================== 设置操作 ====================

/**
 * 保存设置 (替代 KV.put)
 */
D1Database.prototype.putSetting = function(key, value, category) {
    if (!category && key.startsWith('manage@sysConfig@')) {
        category = key.split('@')[2];
    }
    
    var stmt = this.db.prepare(
        'INSERT OR REPLACE INTO settings (key, value, category) VALUES (?, ?, ?)'
    );
    
    return stmt.bind(key, value, category).run();
};

/**
 * 获取设置 (替代 KV.get)
 */
D1Database.prototype.getSetting = function(key) {
    var stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    return stmt.bind(key).first().then(function(result) {
        return result ? result.value : null;
    });
};

/**
 * 删除设置 (替代 KV.delete)
 */
D1Database.prototype.deleteSetting = function(key) {
    var stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    return stmt.bind(key).run();
};

/**
 * 列出设置 (替代 KV.list)
 */
D1Database.prototype.listSettings = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var limit = options.limit || 1000;
    
    var query = 'SELECT key, value FROM settings';
    var params = [];
    
    if (prefix) {
        query += ' WHERE key LIKE ?';
        params.push(prefix + '%');
    }
    
    query += ' ORDER BY key LIMIT ?';
    params.push(limit);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        var keys = results.map(function(row) {
            return {
                name: row.key,
                value: row.value
            };
        });

        return { keys: keys };
    });
};

// ==================== 索引操作 ====================

/**
 * 保存索引操作记录
 */
D1Database.prototype.putIndexOperation = function(operationId, operation) {
    var stmt = this.db.prepare(
        'INSERT OR REPLACE INTO index_operations (id, type, timestamp, data) VALUES (?, ?, ?, ?)'
    );
    
    return stmt.bind(
        operationId,
        operation.type,
        operation.timestamp,
        JSON.stringify(operation.data)
    ).run();
};

/**
 * 获取索引操作记录
 */
D1Database.prototype.getIndexOperation = function(operationId) {
    var stmt = this.db.prepare('SELECT * FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).first().then(function(result) {
        if (!result) return null;
        
        return {
            type: result.type,
            timestamp: result.timestamp,
            data: JSON.parse(result.data)
        };
    });
};

/**
 * 删除索引操作记录
 */
D1Database.prototype.deleteIndexOperation = function(operationId) {
    var stmt = this.db.prepare('DELETE FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).run();
};

// Folder pages can enqueue many operations in short succession. Keep index
// merges from spending one D1 query per operation read and per deletion.
D1Database.prototype.listPendingIndexOperations = async function(limit) {
    // Rows, not the previous random operation ID, are the work queue.
    const response = await this.db.prepare('SELECT id, type, timestamp, data FROM index_operations ORDER BY id LIMIT ?')
        .bind(limit).all();
    return (response.results || []).map(row => ({ ...row, data: JSON.parse(row.data) }));
};

D1Database.prototype.getIndexFiles = async function(ids) {
    const result = await this.db.prepare('SELECT id, metadata FROM files WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(ids)).all();
    return (result.results || []).map(row => ({ id: row.id, metadata: JSON.parse(row.metadata || '{}') }));
};

D1Database.prototype.readIndexSnapshot = async function() {
    const key = 'manage@index@meta';
    const metadata = await this.getSetting(key);
    if (metadata == null) return new Map();
    const count = JSON.parse(metadata).chunkCount;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid index chunk count');
    const snapshot = new Map([[key, metadata]]);
    // Keep each result below D1's response size ceiling and never mix chunks
    // from two revisions. Every chunk read is conditional on the same meta.
    for (let start = 0; start < count; start += 16) {
        const keys = Array.from({ length: Math.min(16, count - start) }, (_, i) => `manage@index_${start + i}`);
        const response = await this.db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})
            AND (SELECT value FROM settings WHERE key = ?) = ?`).bind(...keys, key, metadata).all();
        if (response.results?.length !== keys.length) throw new Error('Index chunks missing or index changed during read');
        for (const row of response.results) snapshot.set(row.key, row.value);
    }
    return snapshot;
};

D1Database.prototype.writeIndexSnapshot = async function(metadata, chunks, expected, operationIds = []) {
    const key = 'manage@index@meta';
    const value = JSON.stringify({ ...metadata, revision: crypto.randomUUID() });
    const begin = expected === undefined
        ? this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value)
        : expected === null
            ? this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(key, value)
            : this.db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?').bind(value, key, expected);
    const statements = [begin];
    for (let i = 0; i < chunks.length; i++) {
        statements.push(this.db.prepare('INSERT OR REPLACE INTO settings (key, value) SELECT ?, ? WHERE (SELECT value FROM settings WHERE key = ?) = ?')
            .bind(`manage@index_${i}`, JSON.stringify(chunks[i]), key, value));
    }
    statements.push(this.db.prepare(`DELETE FROM settings WHERE key GLOB 'manage@index_[0-9]*'
        AND CAST(substr(key, length('manage@index_') + 1) AS INTEGER) >= ? AND (SELECT value FROM settings WHERE key = ?) = ?`)
        .bind(chunks.length, key, value));
    if (operationIds.length) {
        statements.push(this.db.prepare('DELETE FROM index_operations WHERE id IN (SELECT value FROM json_each(?)) AND (SELECT value FROM settings WHERE key = ?) = ?')
            .bind(JSON.stringify(operationIds), key, value));
    }
    const results = await this.db.batch(statements);
    return results[0]?.meta?.changes > 0;
};

D1Database.prototype.deleteIndexOperations = function(operationIds) {
    // Callers chunk to stay within D1's 100 bound-parameter limit.
    return this.db.prepare(`DELETE FROM index_operations WHERE id IN (${operationIds.map(() => '?').join(',')})`)
        .bind(...operationIds).run();
};

/**
 * 列出索引操作记录
 */
D1Database.prototype.listIndexOperations = function(options) {
    options = options || {};
    var limit = options.limit || 1000;
    var processed = options.processed;
    
    var query = 'SELECT * FROM index_operations';
    var params = [];
    
    if (processed !== null && processed !== undefined) {
        query += ' WHERE processed = ?';
        params.push(processed);
    }
    
    query += ' ORDER BY timestamp LIMIT ?';
    params.push(limit);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        return results.map(function(row) {
            return {
                id: row.id,
                type: row.type,
                timestamp: row.timestamp,
                data: JSON.parse(row.data),
                processed: row.processed
            };
        });
    });
};

// ==================== 工具方法 ====================

/**
 * 从metadata中提取字段用于索引
 */
D1Database.prototype.extractMetadataFields = function(metadata) {
    return {
        fileName: metadata.FileName || null,
        fileType: metadata.FileType || null,
        fileSize: metadata.FileSize || null,
        uploadIP: metadata.UploadIP || null,
        uploadAddress: metadata.UploadAddress || null,
        listType: metadata.ListType || null,
        timestamp: metadata.TimeStamp || null,
        label: metadata.Label || null,
        directory: metadata.Directory || null,
        channel: metadata.Channel || null,
        channelName: metadata.ChannelName || null,
        tgFileId: metadata.TgFileId || null,
        tgChatId: metadata.TgChatId || null,
        tgBotToken: metadata.TgBotToken || null,
        isChunked: metadata.IsChunked || false
    };
};

// ==================== 通用方法 ====================

/**
 * 通用的put方法，根据key类型自动选择存储位置
 */
D1Database.prototype.put = function(key, value, options) {
    options = options || {};

    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        var operation = JSON.parse(value);
        return this.putIndexOperation(operationId, operation);
    } else if (key.startsWith('manage@')) {
        // 所有 manage@ 前缀的键统一存入 settings 表
        var category = key.split('@')[1] || '';
        return this.putSetting(key, value, category);
    } else {
        return this.putFile(key, value, options);
    }
};

/**
 * 通用的get方法，根据key类型自动选择获取位置
 */
D1Database.prototype.get = function(key) {
    var self = this;

    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.getIndexOperation(operationId).then(function(operation) {
            return operation ? JSON.stringify(operation) : null;
        });
    } else if (key.startsWith('manage@')) {
        return this.getSetting(key);
    } else {
        return this.getFile(key).then(function(file) {
            return file ? file.value : null;
        });
    }
};

/**
 * 通用的getWithMetadata方法
 */
D1Database.prototype.getWithMetadata = function(key) {
    var self = this;

    if (key.startsWith('manage@')) {
        return this.getSetting(key).then(function(value) {
            return value ? { value: value, metadata: {} } : null;
        });
    } else {
        return this.getFileWithMetadata(key);
    }
};

/**
 * 通用的delete方法
 */
D1Database.prototype.delete = function(key) {
    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.deleteIndexOperation(operationId);
    } else if (key.startsWith('manage@')) {
        return this.deleteSetting(key);
    } else {
        return this.deleteFile(key);
    }
};

/**
 * 通用的list方法
 */
D1Database.prototype.list = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var self = this;

    if (prefix.startsWith('manage@index@operation_')) {
        return this.listIndexOperations(options).then(function(operations) {
            var keys = operations.map(function(op) {
                return {
                    name: 'manage@index@operation_' + op.id
                };
            });
            return { keys: keys };
        });
    } else if (prefix.startsWith('manage@')) {
        return this.listSettings(options);
    } else {
        return this.listFiles(options);
    }
};

// 导出构造函数
export { D1Database };
