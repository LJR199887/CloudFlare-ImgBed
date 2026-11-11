import { prepareMetadataForStorage } from '../../../utils/metadata/webdavIdentity.js';
import { S3Client, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from "../../../utils/purgeCache";
import { moveFileInIndex, batchMoveFilesInIndex } from "../../../utils/indexManager.js";
import { deletionMayStillApply, guardProviderWrite, preflightFileMutationWrite, withFileMutation, FileMutationConflict } from '../../../utils/fileMutation.js';
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { sanitizeUploadFolder } from "../../../upload/uploadTools.js";
import { WebDAVAPI } from "../../../utils/storage/webdavAPI.js";
import { resolveWebDAVConfig } from "../../../utils/webdavConfig.js";
import { hydrateFileCredentials } from '../../../utils/metadata/fileCredentials.js';
import { assertLegacyWriteSafe } from '../../../utils/metadata/writeSafety.js';

export async function onRequest(context) {
    const { request, env, params, waitUntil } = context;

    const url = new URL(request.url);
    const warnings = [];

    // 读取目标文件夹，并进行路径安全处理
    const rawDist = url.searchParams.get('dist') || '';
    const dist = sanitizeUploadFolder(rawDist);

    // 读取folder参数，判断是否为文件夹移动请求
    const folder = url.searchParams.get('folder');
    if (folder === 'true') {
        try {
            params.path = decodeURIComponent(params.path);
            // 使用队列存储需要处理的文件夹
            const folderQueue = [{
                path: params.path.split(',').join('/'),
                dist: dist
            }];

            const processedFiles = [];
            const failedFiles = [];

            while (folderQueue.length > 0) {
                const currentFolder = folderQueue.shift();
                const curFolderName = currentFolder.path.split('/').pop();

                // 获取指定目录下的所有文件
                const listUrl = new URL(`${url.origin}/api/manage/list?count=-1&dir=${currentFolder.path}`);
                const listRequest = new Request(listUrl, {
                    headers: request.headers,
                });
                const listResponse = await fetch(listRequest);
                const listData = await listResponse.json();

                const files = listData.files;
                const folderDist = currentFolder.dist === '' ? curFolderName : `${currentFolder.dist}/${curFolderName}`;

                // 处理当前文件夹下的所有文件
                for (const file of files) {
                    const fileId = file.name;
                    const fileName = file.name.split('/').pop();
                    const newFileId = `${folderDist}/${fileName}`;
                    const cdnUrl = `https://${url.hostname}/file/${fileId}`;

                    const success = await moveFile(env, fileId, newFileId, cdnUrl, url, warnings);
                    if (success) {
                        processedFiles.push({ fileId: fileId, newFileId: newFileId });
                    } else {
                        failedFiles.push(fileId);
                    }
                }

                // 将子文件夹添加到队列
                const directories = listData.directories;
                for (const dir of directories) {
                    folderQueue.push({
                        path: dir,
                        dist: folderDist
                    });
                }
            }

            // 批量从索引中删除文件，添加新文件
            if (processedFiles.length > 0) {
                waitUntil(batchMoveFilesInIndex(context, processedFiles.map(file => {
                    return {
                        originalFileId: file.fileId,
                        newFileId: file.newFileId,
                    };
                })));
            }

            // 返回处理结果
            return new Response(JSON.stringify({
                success: true,
                processed: processedFiles,
                warnings,
                failed: failedFiles
            }));

        } catch (e) {
            return new Response(JSON.stringify({
                success: false,
                error: e.message
            }), { status: 400 });
        }
    }

    // 单个文件移动处理
    try {
        // 解码params.path
        params.path = decodeURIComponent(params.path);
        const fileId = params.path.split(',').join('/');
        const fileKey = fileId.split('/').pop();
        const newFileId = dist === '' ? fileKey : `${dist}/${fileKey}`;
        const cdnUrl = `https://${url.hostname}/file/${fileId}`;

        const success = await moveFile(env, fileId, newFileId, cdnUrl, url, warnings);
        if (!success) {
            throw new Error('Move file failed');
        } else {
            // 从索引中删除旧文件，并添加新文件
            waitUntil(moveFileInIndex(context, fileId, newFileId));
        }

        return new Response(JSON.stringify({
            success: true,
            fileId: fileId,
            newFileId: newFileId,
            warnings
        }));
    } catch (e) {
        return new Response(JSON.stringify({
            success: false,
            error: e.message
        }), { status: 400 });
    }
}

// 移动单个文件的核心函数
async function moveFile(env, fileId, newFileId, cdnUrl, url, warnings) {
    try {
        return await withFileMutation(env, [fileId, newFileId], async (env, retainClaim) => {
            const db = getDatabase(env);

            // 读取图片信息
            const img = await db.getWithMetadata(fileId);
            if (!img?.metadata) throw new Error('File not found');
            if (fileId === newFileId) return true;
            // Refuse collisions before copying/deleting any storage object. In
            // particular, the destination may have protected legacy credentials.
            const destination = await db.getWithMetadata(newFileId);
            if (destination && destination.value != null) throw new Error('Target file already exists');
            await assertLegacyWriteSafe(db, env, fileId);
            img.metadata = await hydrateFileCredentials(env, img.metadata);

            // Keep the source usable until the destination record is committed.
            let copyDestination = async () => {};
            let deleteSource = async () => {};

            // 如果是R2渠道的图片，需要移动R2中对应的图片
            if (img.metadata?.Channel === 'CloudflareR2') {
                const R2DataBase = env.img_r2;

                copyDestination = async () => {
                    // 获取原文件内容
                    const object = await R2DataBase.get(fileId);
                    if (!object) {
                        throw new Error('R2 Object Not Found');
                    }

                    // 复制到新位置
                    const copied = await R2DataBase.put(newFileId, object.body, {
                        httpMetadata: object.httpMetadata,
                        customMetadata: object.customMetadata,
                        onlyIf: new Headers({ 'If-None-Match': '*' }),
                    });
                    if (copied === null) throw new FileMutationConflict();
                };

                // 删除旧文件
                deleteSource = () => R2DataBase.delete(fileId);
            }

            // S3 渠道的图片，需要移动S3中对应的图片
            if (img.metadata?.Channel === 'S3') {
                const plan = planS3Copy(img, newFileId, () => retainClaim(newFileId));
                copyDestination = plan.copy;
                deleteSource = plan.cleanup;
                // The old CDN URL could serve another file when the source key is reused.
                if (img.metadata.S3FileKey !== newFileId) delete img.metadata.S3CdnFileUrl;
                img.metadata.S3FileKey = newFileId;
                const s3ServerDomain = img.metadata.S3Endpoint.replace(/https?:\/\//, "");
                img.metadata.S3Location = `https://${img.metadata.S3BucketName}.${s3ServerDomain}/${newFileId}`;
            }

            // WebDAV 渠道的图片，需要移动 WebDAV 中对应的文件
            if (img.metadata?.Channel === 'WebDAV') {
                const plan = await planWebDAVCopy(env, img, newFileId);
                const { webdavConfig } = plan;
                copyDestination = plan.copy;
                deleteSource = plan.cleanup;
                img.metadata.WebDAVFilePath = newFileId;
                if (img.metadata.WebDAVPublicBaseUrl || img.metadata.WebDAVPublicUrl || webdavConfig?.publicUrl) {
                    const webdavAPI = new WebDAVAPI(webdavConfig || { baseUrl: img.metadata.WebDAVBaseUrl });
                    const publicBaseUrl = img.metadata.WebDAVPublicBaseUrl
                        || webdavConfig?.publicUrl
                        || img.metadata.WebDAVPublicUrl.slice(0, img.metadata.WebDAVPublicUrl.length - fileId.split('/').map(encodeURIComponent).join('/').length);
                    img.metadata.WebDAVPublicBaseUrl = publicBaseUrl;
                    img.metadata.WebDAVPublicUrl = webdavAPI.buildPublicUrl(newFileId, publicBaseUrl);
                }
            }

            // 旧版 Telegram 渠道和 Telegraph 渠道不支持移动
            if (img.metadata?.Channel === 'Telegram' || img.metadata?.Channel === undefined) {
                throw new Error('Unsupported Channel');
            }

            // 更新文件夹信息，根目录为空，否则为 aaa/123/ 的格式
            const DirectoryPath = newFileId.split('/').slice(0, -1).join('/') === '' ? '' : newFileId.split('/').slice(0, -1).join('/') + '/';
            img.metadata.Directory = DirectoryPath;

            // 更新KV存储
            const persistedMetadata = await prepareMetadataForStorage(img.metadata);
            preflightFileMutationWrite(env, newFileId, persistedMetadata);
            await copyDestination();
            await db.put(newFileId, img.value, { metadata: img.metadata });

            // Do not release the source name while its object deletion is pending:
            // uploads use this record to avoid reusing a key still being cleaned up.
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
                warnings.push(cleanupWarning);
            }

            // 清除CDN缓存
            await purgeCFCache(env, cdnUrl);

            // 清除 api/randomFileList 等API缓存
            const normalizedFolder = fileId.split('/').slice(0, -1).join('/');
            const normalizedDist = newFileId.split('/').slice(0, -1).join('/');
            await purgeRandomFileListCache(url.origin, normalizedFolder, normalizedDist);
            await purgePublicFileListCache(url.origin, normalizedFolder, normalizedDist);

            return true;
        });
    } catch (e) {
        console.error('Move file failed:', e);
        return false;
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
