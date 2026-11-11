import { S3Client, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from "../../../utils/purgeCache";
import { moveFileInIndex } from "../../../utils/indexManager.js";
import { deletionMayStillApply, guardProviderWrite, preflightFileMutationWrite, withFileMutation, FileMutationConflict } from '../../../utils/fileMutation.js';
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { sanitizeUploadFolder } from "../../../upload/uploadTools.js";
import { WebDAVAPI } from "../../../utils/storage/webdavAPI.js";
import { resolveWebDAVConfig } from "../../../utils/webdavConfig.js";
import { hydrateFileCredentials } from '../../../utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../../../utils/metadata/writeSafety.js';
import { prepareMetadataForStorage } from '../../../utils/metadata/webdavIdentity.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env, params, waitUntil } = context;

    // OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
        });
    }

    // 仅允许 POST 方法
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({
            success: false,
            message: 'Method not allowed. Use POST.',
        }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }

    try {
        // 从 params.path 解析 fileId（需要 decodeURIComponent 处理中文等特殊字符）
        const fileId = decodeURIComponent(params.path).split(',').join('/');

        if (!fileId) {
            return new Response(JSON.stringify({
                success: false,
                message: 'File ID is required.',
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }

        // 解析请求体
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return new Response(JSON.stringify({
                success: false,
                message: 'Invalid request body. Expected JSON.',
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }

        // 验证请求体中包含 newFileId
        if (!body || typeof body.newFileId !== 'string' || !body.newFileId.trim()) {
            return new Response(JSON.stringify({
                success: false,
                message: 'newFileId is required and must be a non-empty string.',
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }

        // 路径安全处理
        const newFileId = sanitizeUploadFolder(body.newFileId.trim());

        return await withFileMutation(env, [fileId, newFileId], async (env, retainClaim) => {
            const url = new URL(request.url);
            const db = getDatabase(env);

            // 获取当前文件数据
            const fileData = await db.getWithMetadata(fileId);

            if (!fileData || !fileData.metadata) {
                return new Response(JSON.stringify({
                    success: false,
                    message: 'File not found.',
                }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
            }

            // 检查目标 File_ID 是否已存在（重复性检测）
            const existingFile = await db.getWithMetadata(newFileId);
            if (existingFile && existingFile.value !== null) {
                return new Response(JSON.stringify({
                    success: false,
                    message: '目标文件名已存在',
                }), {
                    status: 409,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
            }

            await assertLegacyWriteSafe(db, env, fileId);
            fileData.metadata = await hydrateFileCredentials(env, fileData.metadata);

            // 执行文件迁移
            const metadata = { ...fileData.metadata };

            // Keep the source usable until the destination record is committed.
            let copyDestination = async () => {};
            let deleteSource = async () => {};

            // 如果是 R2 渠道的图片，需要移动 R2 中对应的图片
            if (metadata?.Channel === 'CloudflareR2') {
                const R2DataBase = env.img_r2;

                copyDestination = async () => {
                    // 获取原文件内容
                    const object = await R2DataBase.get(fileId);
                    if (!object) {
                        throw new Error('R2 Object Not Found');
                    }

                    // 复制到新位置
                    const copied = await guardProviderWrite(() => R2DataBase.put(newFileId, object.body, {
                        httpMetadata: object.httpMetadata,
                        customMetadata: object.customMetadata,
                        onlyIf: new Headers({ 'If-None-Match': '*' }),
                    }), () => retainClaim(newFileId));
                    if (copied === null) throw new FileMutationConflict();
                };

                // 删除旧文件
                deleteSource = () => R2DataBase.delete(fileId);
            }

            // S3 渠道的图片，需要移动 S3 中对应的图片
            if (metadata?.Channel === 'S3') {
                const plan = planS3Copy(fileData, newFileId, () => retainClaim(newFileId));
                copyDestination = plan.copy;
                deleteSource = plan.cleanup;
                // The old CDN URL could serve another file when the source key is reused.
                if (metadata.S3FileKey !== newFileId) delete metadata.S3CdnFileUrl;
                metadata.S3FileKey = newFileId;
                const s3ServerDomain = metadata.S3Endpoint.replace(/https?:\/\//, "");
                metadata.S3Location = `https://${metadata.S3BucketName}.${s3ServerDomain}/${newFileId}`;
            }

            // WebDAV 渠道的图片，需要移动 WebDAV 中对应的文件
            if (metadata?.Channel === 'WebDAV') {
                const plan = await planWebDAVCopy(env, fileData, newFileId);
                const { webdavConfig } = plan;
                copyDestination = plan.copy;
                deleteSource = plan.cleanup;
                metadata.WebDAVFilePath = newFileId;
                if (metadata.WebDAVPublicBaseUrl || metadata.WebDAVPublicUrl || webdavConfig?.publicUrl) {
                    const webdavAPI = new WebDAVAPI(webdavConfig || { baseUrl: metadata.WebDAVBaseUrl });
                    const publicBaseUrl = metadata.WebDAVPublicBaseUrl
                        || webdavConfig?.publicUrl
                        || metadata.WebDAVPublicUrl.slice(0, metadata.WebDAVPublicUrl.length - fileId.split('/').map(encodeURIComponent).join('/').length);
                    metadata.WebDAVPublicBaseUrl = publicBaseUrl;
                    metadata.WebDAVPublicUrl = webdavAPI.buildPublicUrl(newFileId, publicBaseUrl);
                }
            }

            // 旧版 Telegram 渠道和 Telegraph 渠道不支持重命名
            if (metadata?.Channel === 'Telegram' || metadata?.Channel === undefined) {
                return new Response(JSON.stringify({
                    success: false,
                    message: '旧版 Telegram/Telegraph 渠道不支持重命名',
                }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
            }

            // 更新文件夹信息，根目录为空，否则为 aaa/123/ 的格式
            const DirectoryPath = newFileId.split('/').slice(0, -1).join('/') === '' ? '' : newFileId.split('/').slice(0, -1).join('/') + '/';
            metadata.Directory = DirectoryPath;

            // 更新 KV 存储
            const persistedMetadata = await prepareMetadataForStorage(metadata);
            preflightFileMutationWrite(env, newFileId, persistedMetadata);
            await copyDestination();
            await db.put(newFileId, fileData.value, { metadata });

            // Keep the old name occupied until its object deletion completes.
            // Releasing it first lets a concurrent upload reuse that key and have
            // its new bytes deleted by our delayed cleanup. Never delete the old
            // row after an uncertain object deletion; retain it for reconciliation.
            let cleanupWarning;
            let storageDeleteConfirmed = false;
            try {
                await deleteSource();
                storageDeleteConfirmed = true;
                await db.delete(fileId);
            } catch (error) {
                // A provider may apply a timed-out DELETE later. Do not free
                // the name for reuse until an operator reconciles the claim.
                if (!storageDeleteConfirmed && deletionMayStillApply(error)) retainClaim(fileId);
                console.error('Source object cleanup failed after relocation:', error);
                cleanupWarning = { fileId, newFileId, message: 'File moved; source cleanup incomplete; inspect the old record and object before retrying' };
            }

            // 清除 CDN 缓存
            const cdnUrl = `https://${url.hostname}/file/${fileId}`;
            await purgeCFCache(env, cdnUrl);

            // 清除 api/randomFileList 等 API 缓存
            const normalizedFolder = fileId.split('/').slice(0, -1).join('/');
            const normalizedDist = newFileId.split('/').slice(0, -1).join('/');
            await purgeRandomFileListCache(url.origin, normalizedFolder, normalizedDist);
            await purgePublicFileListCache(url.origin, normalizedFolder, normalizedDist);

            // 更新索引
            waitUntil(moveFileInIndex(context, fileId, newFileId));

            return new Response(JSON.stringify({
                success: true,
                newFileId,
                metadata: persistedMetadata,
                ...(cleanupWarning ? { warnings: [cleanupWarning] } : {}),
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        });

    } catch (error) {
        console.error('Error renaming file:', error);
        return new Response(JSON.stringify({
            success: false,
            message: error.message || 'Internal server error.',
        }), {
            status: [409, 413].includes(error.status) ? error.status : 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }
}

// 移动 S3 渠道的图片
function planS3Copy(img, newFileId, retainDestination) {
    const m = img.metadata;
    const oldKey = m.S3FileKey;
    if (oldKey === newFileId) return { copy: async () => {}, cleanup: async () => {} };
    const s3Client = new S3Client({
        region: m.S3Region || 'auto',
        endpoint: m.S3Endpoint,
        credentials: { accessKeyId: m.S3AccessKeyId, secretAccessKey: m.S3SecretAccessKey },
        forcePathStyle: m.S3PathStyle || false,
    });
    const source = `/${m.S3BucketName}/${oldKey.split('/').map(encodeURIComponent).join('/')}`;
    return {
        copy: () => guardProviderWrite(() => s3Client.send(new CopyObjectCommand({
            Bucket: m.S3BucketName, CopySource: source, Key: newFileId,
        })), retainDestination),
        cleanup: () => s3Client.send(new DeleteObjectCommand({ Bucket: m.S3BucketName, Key: oldKey })),
    };
}

async function planWebDAVCopy(env, img, newFileId) {
    const oldPath = img.metadata.WebDAVFilePath;
    if (!oldPath) throw new Error('WebDAV file missing required metadata for move');
    const webdavConfig = await resolveWebDAVConfig(env, img.metadata);
    if (!webdavConfig) throw new Error('WebDAV channel config not found for move');
    const webdavAPI = new WebDAVAPI(webdavConfig);
    return {
        webdavConfig,
        copy: () => oldPath === newFileId ? Promise.resolve() : webdavAPI.copyFile(oldPath, newFileId, false),
        cleanup: () => oldPath === newFileId ? Promise.resolve() : webdavAPI.deleteFile(oldPath),
    };
}
