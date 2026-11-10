# 凭据安全分支：恢复、删除和响应检查

此分支不合并上游，不引入文件过期功能，继续使用现有自动清理逻辑。

## 行为和兼容性

- 文件 metadata 和管理接口响应不保存/返回渠道凭据；渠道配置仍保存凭据。
- WebDAV 备份在脱敏前生成账号身份摘要，保留已有绑定。更换同名同地址渠道的
  账号，不会让有绑定的历史文件指向新账号。
- 最早版本没有保存 WebDAV 凭据或绑定的记录，导出时按它当前实际匹配的渠道
  生成绑定。渠道无法匹配时拒绝导出，避免制造不能安全恢复的备份。
- **已经脱敏且没有 WebDAVAccountId 的旧备份无法还原原账号身份**，不能靠猜测
  自动绑定。请在原实例配置正确渠道后重新导出；包含历史凭据的原始备份可正常校验。
- 恢复前先导入上传渠道配置，逐条验证文件对应的渠道；配置缺失、身份不匹配或
  必要凭据缺失时，该条记录计入 `failedCount`，原记录不被覆盖。环境变量渠道的
  凭据不在文件备份中，需在目标实例配置。HTTP 200 / `success: true` 仅表示批请求
  已处理，仍须查看 `failedCount` 和 `errors`，不能当成所有文件恢复成功。
- 前端只将上传渠道配置提前，认证等其他设置仍在文件之后恢复。
- Discord 分片删除先校验完整 manifest，再顺序删除消息。任意失败保留数据库
  记录、manifest 和索引；重试时已删除的消息按明确的 Unknown Message 幂等处理。
  不会把普通 404、权限错误、限流或网络故障当作删除成功。
- 自动清理复用相同删除逻辑；没有引入新的清理周期或后台任务。
- 重命名响应返回安全 metadata，与数据库脱敏结果一致。

## 验证

使用 Node.js 22.13+（测试使用内置 `node:sqlite`）或 Node.js 24：

```powershell
npm test
node scripts/patch-restore-order.mjs
node --import ./deploy/server/register.mjs --input-type=module -e "await import('./functions/api/manage/delete/[[path]].js'); await import('./functions/api/manage/rename/[[path]].js'); await import('./functions/api/manage/batch/restore/chunk.js');"
```

新增回归覆盖 KV、真实内存 SQLite 上的 D1 SQL、WebDAV 基本认证/自定义头/URL
userinfo/匿名账号、备份往返、各渠道重命名响应、Discord 分片部分失败和重试、
自动清理索引更新以及编译后前端的一次性恢复流程。

远端存储服务通过可控响应模拟；这些测试不等价于真实 Cloudflare、Discord、
S3、WebDAV 账号的线上联调，也不包含整个项目的依赖漏洞修复。
