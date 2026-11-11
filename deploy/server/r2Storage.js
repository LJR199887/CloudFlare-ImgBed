/**
 * 本地 R2 存储适配器
 * 使用本地文件系统模拟 Cloudflare R2 的 API 接口
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, lstatSync, realpathSync, statSync, rmSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';

export class LocalR2Storage {
    constructor(basePath) {
        mkdirSync(basePath, { recursive: true });
        this.basePath = realpathSync(basePath);
    }

    _filePath(key) {
        const parts = typeof key === 'string' ? key.split('/') : [];
        if (!parts.length || parts[0].toLowerCase() === '_multipart' || parts.some(part => !part || part === '.' || part === '..'
            || /[\\:\u0000-\u001f\u007f]/.test(part)
            || (process.platform === 'win32' && (/[<>"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))))) {
            throw new Error('Invalid local storage key');
        }
        return this._containedPath(...parts);
    }

    _containedPath(...parts) {
        const target = resolve(this.basePath, ...parts);
        const rel = relative(this.basePath, target);
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Storage path escapes root');
        let current = this.basePath;
        for (const part of rel.split(sep)) {
            current = join(current, part);
            try {
                if (lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not allowed in local storage');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                break;
            }
        }
        return target;
    }

    async head(key) {
        try { return { size: statSync(this._filePath(key)).size }; }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }

    /**
     * 获取文件（模拟 R2 的 get 方法）
     * 支持 Range 请求
     */
    async get(key, options) {
        const filePath = this._filePath(key);
        if (!existsSync(filePath)) return null;

        const stats = statSync(filePath);
        const size = stats.size;
        let body;
        let range;

        if (options && options.range) {
            const offset = options.range.offset || 0;
            const length = options.range.length || (size - offset);
            const end = offset + length - 1;
            const nodeStream = createReadStream(filePath, { start: offset, end: end });
            body = Readable.toWeb(nodeStream);
            range = { offset, length };
        } else {
            const nodeStream = createReadStream(filePath);
            body = Readable.toWeb(nodeStream);
        }

        return {
            body,
            size,
            range,
            httpMetadata: {},
            writeHttpMetadata(headers) {
                // 本地存储不设置额外的 HTTP 元数据
            }
        };
    }

    /**
     * 存储文件（模拟 R2 的 put 方法）
     * 支持多种输入类型
     */
    async put(key, value, options) {
        const filePath = this._filePath(key);
        mkdirSync(dirname(filePath), { recursive: true });

        let buffer;
        if (value instanceof Blob || (typeof File !== 'undefined' && value instanceof File)) {
            buffer = Buffer.from(await value.arrayBuffer());
        } else if (value instanceof ArrayBuffer) {
            buffer = Buffer.from(value);
        } else if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
            buffer = Buffer.from(value);
        } else if (value instanceof ReadableStream) {
            const reader = value.getReader();
            const chunks = [];
            while (true) {
                const { done, value: chunk } = await reader.read();
                if (done) break;
                chunks.push(chunk);
            }
            buffer = Buffer.concat(chunks);
        } else if (typeof value === 'string') {
            buffer = Buffer.from(value, 'utf-8');
        } else {
            buffer = Buffer.from(String(value), 'utf-8');
        }

        this._filePath(key); // recheck after awaiting the incoming body
        const createOnly = options?.onlyIf?.get?.('If-None-Match') === '*';
        try { writeFileSync(filePath, buffer, { flag: createOnly ? 'wx' : 'w' }); }
        catch (error) { if (createOnly && error.code === 'EEXIST') return null; throw error; }
        return { size: buffer.length };
    }

    /**
     * 删除文件（模拟 R2 的 delete 方法）
     */
    async delete(key) {
        const filePath = this._filePath(key);
        if (existsSync(filePath)) {
            unlinkSync(filePath);
        }
    }

    /**
     * 创建分块上传（模拟 R2 的 createMultipartUpload 方法）
     */
    async createMultipartUpload(key) {
        this._filePath(key);
        const uploadId = randomUUID();
        const uploadDir = this._containedPath('_multipart', uploadId);
        mkdirSync(uploadDir, { recursive: true });

        // 保存 key 映射
        writeFileSync(join(uploadDir, '_key'), key);

        return {
            uploadId,
            key,
            ...this._createMultipartMethods(key, uploadId)
        };
    }

    /**
     * 恢复分块上传（模拟 R2 的 resumeMultipartUpload 方法）
     */
    resumeMultipartUpload(key, uploadId) {
        return {
            uploadId,
            key,
            ...this._createMultipartMethods(key, uploadId)
        };
    }

    _createMultipartMethods(key, uploadId) {
        const self = this;
        this._filePath(key);
        if (typeof uploadId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uploadId)) throw new Error('Invalid multipart upload ID');
        const marker = () => self._containedPath('_multipart', uploadId, '_key');
        const ensureUpload = () => {
            if (!existsSync(marker()) || readFileSync(marker(), 'utf8') !== key) throw new Error('Multipart upload does not match storage key');
        };
        const partFile = number => {
            if (!Number.isInteger(number) || number < 1 || number > 10000) throw new Error('Invalid multipart part number');
            return self._containedPath('_multipart', uploadId, `part_${String(number).padStart(6, '0')}`);
        };

        return {
            async uploadPart(partNumber, data) {
                ensureUpload();
                let buffer;
                if (data instanceof ArrayBuffer) {
                    buffer = Buffer.from(data);
                } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
                    buffer = Buffer.from(data);
                } else if (data instanceof Blob) {
                    buffer = Buffer.from(await data.arrayBuffer());
                } else if (data instanceof ReadableStream) {
                    const reader = data.getReader();
                    const chunks = [];
                    while (true) {
                        const { done, value: chunk } = await reader.read();
                        if (done) break;
                        chunks.push(chunk);
                    }
                    buffer = Buffer.concat(chunks);
                } else {
                    buffer = Buffer.from(data);
                }
                ensureUpload();
                writeFileSync(partFile(partNumber), buffer);
                return { etag: `etag_${partNumber}`, partNumber };
            },

            async complete(parts) {
                ensureUpload();
                // 按 partNumber 排序合并所有分块
                const sortedParts = parts.sort((a, b) => a.partNumber - b.partNumber);
                const chunks = [];
                for (const part of sortedParts) {
                    const partPath = partFile(part.partNumber);
                    if (!existsSync(partPath)) throw new Error('Multipart part missing');
                    chunks.push(readFileSync(partPath));
                }
                const merged = Buffer.concat(chunks);
                const object = await self.put(key, merged, { onlyIf: new Headers({ 'If-None-Match': '*' }) });
                if (!object) throw new Error('Multipart target already exists');

                // 清理分块目录
                self._cleanupMultipart(uploadId);
            },

            async abort() {
                if (!existsSync(marker())) return;
                ensureUpload();
                // 清理分块目录
                self._cleanupMultipart(uploadId);
            }
        };
    }

    _cleanupMultipart(uploadId) {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uploadId)) throw new Error('Invalid multipart upload ID');
        const dir = this._containedPath('_multipart', uploadId);
        if (existsSync(dir)) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch (e) {
                console.error('Cleanup error:', e.message);
            }
        }
    }
}
