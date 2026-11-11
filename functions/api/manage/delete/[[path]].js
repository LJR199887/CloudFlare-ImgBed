import { needsPagedFolderMutation, runPagedFolderMutation } from '../../../utils/folderMutation.js';
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from "../../../utils/purgeCache";
import { removeFileFromIndex, batchRemoveFilesFromIndex } from "../../../utils/indexManager.js";
import { deletionMayStillApply, withFileMutation } from '../../../utils/fileMutation.js';
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { DiscordAPI } from '../../../utils/storage/discordAPI.js';
import { HuggingFaceAPI } from '../../../utils/storage/huggingfaceAPI.js';
import { WebDAVAPI } from '../../../utils/storage/webdavAPI.js';
import { resolveWebDAVConfig } from '../../../utils/webdavConfig.js';
import { hydrateFileCredentials } from '../../../utils/metadata/fileCredentials.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env, params, waitUntil } = context;

    const url = new URL(request.url);

    // 读取folder参数，判断是否为文件夹删除请求
    const folder = url.searchParams.get('folder');
    if (folder === 'true') {
        try {
            params.path = decodeURIComponent(params.path);
            if (needsPagedFolderMutation(env)) {
                const folder = params.path.split(',').join('/').replace(/\/$/, '');
                return await runPagedFolderMutation(context, {
                    folder, resultKey: 'deleted', headers: corsHeaders,
                    async mutate(fileId, canDelete) {
                        return await deleteFile(env, fileId, `https://${url.hostname}/file/${fileId}`, url, canDelete) ? fileId : null;
                    },
                    queueIndex: ids => batchRemoveFilesFromIndex(context, ids),
                });
            }
            // 使用队列存储需要处理的文件夹
            const folderQueue = [{
                path: params.path.split(',').join('/')
            }];

            const deletedFiles = [];
            const failedFiles = [];

            while (folderQueue.length > 0) {
                const currentFolder = folderQueue.shift();

                // 获取指定目录下的所有文件
                const listUrl = new URL(`${url.origin}/api/manage/list?count=-1&dir=${currentFolder.path}`);
                const listRequest = new Request(listUrl, {
                    headers: request.headers,
                });
                const listResponse = await fetch(listRequest);
                const listData = await listResponse.json();

                const files = listData.files;

                // 处理当前文件夹下的所有文件
                for (const file of files) {
                    const fileId = file.name;
                    const cdnUrl = `https://${url.hostname}/file/${fileId}`;

                    const success = await deleteFile(env, fileId, cdnUrl, url);
                    if (success) {
                        deletedFiles.push(fileId);
                    } else {
                        failedFiles.push(fileId);
                    }
                }

                // 将子文件夹添加到队列
                const directories = listData.directories;
                for (const dir of directories) {
                    folderQueue.push({
                        path: dir
                    });
                }
            }

            // 批量从索引中删除文件
            if (deletedFiles.length > 0) {
                waitUntil(batchRemoveFilesFromIndex(context, deletedFiles));
            }

            return new Response(JSON.stringify({
                success: true,
                deleted: deletedFiles,
                failed: failedFiles
            }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });

        } catch (e) {
            return new Response(JSON.stringify({
                success: false,
                error: e.message
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }
    }

    // 单个文件删除处理
    try {
        // 解码params.path
        params.path = decodeURIComponent(params.path);
        const fileId = params.path.split(',').join('/');
        const cdnUrl = `https://${url.hostname}/file/${fileId}`;

        const success = await deleteFile(env, fileId, cdnUrl, url);
        if (!success) {
            throw new Error('Delete file failed');
        } else {
            // 从索引中删除文件
            waitUntil(removeFileFromIndex(context, fileId));
        }

        return new Response(JSON.stringify({
            success: true,
            fileId: fileId
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    } catch (e) {
        return new Response(JSON.stringify({
            success: false,
            error: e.message
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}

// 删除单个文件的核心函数
export async function deleteFile(env, fileId, cdnUrl, url, canDelete = null) {
    try {
        return await withFileMutation(env, [fileId], async (env, retainClaim) => {
            // 读取图片信息
            const db = getDatabase(env);
            const img = await db.getWithMetadata(fileId);

            // 如果文件记录不存在，直接返回成功（幂等删除）
            if (!img || (img.value == null && !img.metadata)) {
                console.warn(`File ${fileId} not found in database, skipping delete`);
                return true;
            }
            if (canDelete && !canDelete(img)) return false;
            img.metadata = await hydrateFileCredentials(env, img.metadata);

            // 如果是R2渠道的图片，需要删除R2中对应的图片
            if (img.metadata?.Channel === 'CloudflareR2') {
                const R2DataBase = env.img_r2;
                if (!R2DataBase) throw new Error('R2 binding not configured');
                try { await R2DataBase.delete(fileId); }
                catch (error) { if (deletionMayStillApply(error)) retainClaim(fileId); throw error; }
            }

            // S3 渠道的图片，需要删除S3中对应的图片
            if (img.metadata?.Channel === 'S3') {
                if (!await deleteS3File(img, () => retainClaim(fileId))) throw new Error('S3 deletion failed');
            }

            // Discord 渠道的图片，需要删除 Discord 中对应的消息
            if (img.metadata?.Channel === 'Discord') {
                if (!await deleteDiscordFile(img)) throw new Error('Discord deletion failed');
            }

            // HuggingFace 渠道的图片，需要删除 HuggingFace 中对应的文件
            if (img.metadata?.Channel === 'HuggingFace') {
                if (!await deleteHuggingFaceFile(img)) throw new Error('HuggingFace deletion failed');
            }

            // WebDAV 渠道的图片，需要删除 WebDAV 中对应的文件
            if (img.metadata?.Channel === 'WebDAV') {
                if (!await deleteWebDAVFile(env, img, () => retainClaim(fileId))) throw new Error('WebDAV deletion failed');
            }

            // 删除数据库中的记录
            // 注意：容量统计现在由索引自动维护，删除文件后索引更新时会自动重新计算
            await db.delete(fileId);

            // 清除CDN缓存
            await purgeCFCache(env, cdnUrl);

            // 清除 api/randomFileList 等API缓存
            const normalizedFolder = fileId.split('/').slice(0, -1).join('/');
            await purgeRandomFileListCache(url.origin, normalizedFolder);
            await purgePublicFileListCache(url.origin, normalizedFolder);

            return true;
        });
    } catch (e) {
        console.error('Delete file failed:', e);
        return false;
    }
}

// 删除 S3 渠道的图片
async function deleteS3File(img, onUncertainDelete) {
    const m = img.metadata;
    if (!m?.S3BucketName || !m.S3FileKey || !m.S3AccessKeyId || !m.S3SecretAccessKey) return false;
    const s3Client = new S3Client({
        region: img.metadata?.S3Region || "auto",
        endpoint: img.metadata?.S3Endpoint,
        credentials: {
            accessKeyId: img.metadata?.S3AccessKeyId,
            secretAccessKey: img.metadata?.S3SecretAccessKey
        },
        forcePathStyle: img.metadata?.S3PathStyle || false // 是否启用路径风格
    });

    const bucketName = img.metadata?.S3BucketName;
    const key = img.metadata?.S3FileKey;

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        }));
        return true;
    } catch (error) {
        if (deletionMayStillApply(error)) onUncertainDelete();
        console.error("S3 Delete Failed:", error);
        return false;
    }
}

// 删除 Discord 渠道的图片（删除 Discord 消息）
async function deleteDiscordFile(img) {
    const botToken = img.metadata?.DiscordBotToken;
    const channelId = img.metadata?.DiscordChannelId;
    if (!botToken || !channelId) {
        console.warn('Discord file missing required metadata for deletion');
        return false;
    }

    try {
        let messageIds;
        if (img.metadata.IsChunked) {
            const chunks = JSON.parse(img.value);
            const expected = img.metadata.TotalChunks;
            // Validate the entire manifest before deleting anything. A broken
            // manifest must not cause a partially destroyed file or a lost row.
            if (!Array.isArray(chunks) || chunks.length === 0 ||
                (expected != null && (!Number.isInteger(expected) || expected !== chunks.length)) ||
                chunks.some(chunk => !chunk || !Number.isInteger(chunk.index) ||
                    chunk.index < 0 || chunk.index >= chunks.length ||
                    typeof chunk.messageId !== 'string' || !chunk.messageId.trim()) ||
                new Set(chunks.map(chunk => chunk.index)).size !== chunks.length) {
                throw new Error('Invalid Discord chunk manifest');
            }
            messageIds = [...new Set(chunks.map(chunk => chunk.messageId))];
        } else {
            const messageId = img.metadata.DiscordMessageId;
            if (typeof messageId !== 'string' || !messageId.trim()) {
                throw new Error('Discord file missing message ID');
            }
            messageIds = [messageId];
        }
        const discordAPI = new DiscordAPI(botToken);
        // Sequential requests avoid a burst against the channel rate limit.
        // Keep the full manifest on failure; already-deleted messages succeed
        // idempotently on the next manual/automatic cleanup attempt.
        for (const messageId of messageIds) {
            if (!await discordAPI.deleteMessage(channelId, messageId)) {
                console.error('Discord Delete Failed: API returned false');
                return false;
            }
        }
        return true;
    } catch (error) {
        console.error("Discord Delete Failed:", error);
        return false;
    }
}


// 删除 HuggingFace 渠道的图片
async function deleteHuggingFaceFile(img) {
    const token = img.metadata?.HfToken;
    const repo = img.metadata?.HfRepo;
    const filePath = img.metadata?.HfFilePath;
    const isPrivate = img.metadata?.HfIsPrivate || false;

    if (!token || !repo || !filePath) {
        console.warn('HuggingFace file missing required metadata for deletion');
        return false;
    }

    try {
        const huggingfaceAPI = new HuggingFaceAPI(token, repo, isPrivate);
        const success = await huggingfaceAPI.deleteFile(filePath, `Delete ${filePath}`);
        if (!success) {
            console.error('HuggingFace Delete Failed: API returned false');
        }
        return success;
    } catch (error) {
        console.error("HuggingFace Delete Failed:", error);
        return false;
    }
}


// 删除 WebDAV 渠道的图片
async function deleteWebDAVFile(env, img, onUncertainDelete) {
    const filePath = img.metadata?.WebDAVFilePath;

    if (!filePath) {
        console.warn('WebDAV file missing required metadata for deletion');
        return false;
    }

    try {
        const webdavConfig = await resolveWebDAVConfig(env, img.metadata);
        if (!webdavConfig) {
            console.warn('WebDAV channel config not found for deletion');
            return false;
        }

        const webdavAPI = new WebDAVAPI(webdavConfig);
        return await webdavAPI.deleteFile(filePath);
    } catch (error) {
        if (deletionMayStillApply(error)) onUncertainDelete();
        console.error("WebDAV Delete Failed:", error);
        return false;
    }
}
