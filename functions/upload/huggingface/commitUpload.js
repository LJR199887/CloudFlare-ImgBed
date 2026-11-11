import { getHuggingFaceGrant } from '../../utils/huggingFaceGrant.js';
import { withFileMutation, FileMutationConflict } from '../../utils/fileMutation.js';
/**
 * HuggingFace 大文件提交 API
 * 
 * 在前端直接上传文件到 S3 后，调用此 API 提交 LFS 文件引用
 */

import { HuggingFaceAPI } from '../../utils/storage/huggingfaceAPI.js';
import { fetchUploadConfig } from '../../utils/sysConfig.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { moderateContent, endUpload, getUploadIp, getIPAddress, isBlockedUploadIp, createResponse } from '../uploadTools.js';
import { userAuthCheck, UnauthorizedResponse } from '../../utils/auth/userAuth.js';

export async function onRequestPost(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    try {
        // 鉴权
        const requiredPermission = 'upload';
        if (!await userAuthCheck(env, url, request, requiredPermission)) {
            return UnauthorizedResponse('Unauthorized');
        }

        const uploadIp = getUploadIp(request) || '';
        if (await isBlockedUploadIp(env, uploadIp)) return createResponse('IP blocked', { status: 403 });
        const body = await request.json();
        if (typeof body?.fullId !== 'string' || !body.fullId || typeof body.filePath !== 'string') {
            return createResponse('Missing upload ID or path', { status: 400 });
        }

        return await withFileMutation(env, [body.fullId], async env => {
            const session = await getHuggingFaceGrant(env, body);
            if (!session) return createResponse('Upload grant is invalid, expired or already used; start a new upload', { status: 409 });
            const { fullId, filePath, sha256, fileSize, fileName, fileType, channelName, repo } = session.grant;
            const db = getDatabase(env);
            if (await db.get(fullId) != null) throw new FileMutationConflict();
            const uploadConfig = await fetchUploadConfig(env);
            const hfChannel = uploadConfig.huggingface?.channels?.find(c => c.name === channelName && c.repo === repo);
            if (!hfChannel?.token) return createResponse('The granted HuggingFace channel changed; start a new upload', { status: 409 });
            const huggingfaceAPI = new HuggingFaceAPI(hfChannel.token, repo, hfChannel.isPrivate || false);
            // Pure KV may expose a recently consumed grant at another edge.
            // Never use it to attach a second record to a published path.
            if (session.eventual) {
                const existing = await fetch(huggingfaceAPI.getFileURL(filePath), {
                    method: 'HEAD', redirect: 'manual', headers: { Authorization: `Bearer ${hfChannel.token}`, 'Cache-Control': 'no-cache' },
                });
                if (existing.status !== 404) return createResponse('Could not verify the granted path is unused', { status: 409 });
            }
            if (!await session.consume()) throw new FileMutationConflict('Upload grant expired or already used');
            await huggingfaceAPI.commitLfsFile(filePath, sha256, fileSize, `Upload ${fileName}`);

            // 构建文件 URL
            const fileUrl = huggingfaceAPI.getFileURL(filePath);

            // 从 fullId 中提取目录信息
            const dirParts = fullId.split('/').slice(0, -1).join('/');
            const normalizedDirectory = dirParts === '' ? '' : dirParts + '/';

            // 获取上传IP和地址
            const uploadAddress = await getIPAddress(uploadIp);

            // 构建 metadata
            const metadata = {
                FileName: fileName || fullId,
                FileType: fileType,
                Channel: "HuggingFace",
                ChannelName: hfChannel.name || "HuggingFace_env",
                FileSize: (fileSize / 1024 / 1024).toFixed(2),
                FileSizeBytes: fileSize,
                UploadIP: uploadIp,
                UploadAddress: uploadAddress,
                ListType: "None",
                HfRepo: hfChannel.repo,
                HfFilePath: filePath,
                HfIsPrivate: hfChannel.isPrivate || false,
                HfFileUrl: fileUrl,
                TimeStamp: Date.now(),
                Label: "None",
                Directory: normalizedDirectory,
                Tags: []
            };

            // 图像审查（公开仓库）
            if (!hfChannel.isPrivate) {
                try {
                    metadata.Label = await moderateContent(env, fileUrl);
                } catch (e) {
                    console.warn('Content moderation failed:', e.message);
                }
            }

            // 写入数据库
            await db.put(fullId, "", { metadata });

            // 结束上传（更新索引等）
            const uploadContext = {
                env,
                waitUntil,
                uploadConfig,
                url
            };
            waitUntil(endUpload(uploadContext, fullId, metadata));

            // 返回成功响应
            const returnLink = `/file/${fullId}`;
            return createResponse(JSON.stringify({
                success: true,
                src: returnLink,
                fileUrl,
                fullId
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });

        });
    } catch (error) {
        console.error('commitUpload error:', error.message);
        return createResponse(JSON.stringify({ error: error.message }), {
            status: error.status === 409 ? 409 : 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
