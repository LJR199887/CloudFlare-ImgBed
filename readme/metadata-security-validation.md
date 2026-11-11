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
- Telegram 单文件和分片读取只使用匹配渠道的代理。渠道已移除时，不会把默认
  bot token 发给原代理；仍有历史 token 的文件可通过官方 API 读取。
- Telegram/Discord 分片完整备份必须包含可解析的清单。读不到清单或校验失败时，
  导出报错，恢复也不会用残缺记录覆盖现有文件；普通列表查询不要求载入清单。
- WebDAV 私有端点 URL 中的用户名和密码只用于构造认证头，不进入请求 URL；
  对外公开的 WebDAV 链接会移除 URL 中的用户名和密码。

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

## 合并前的跨链路检查

- 文件出口共用同一策略：已知的普通图片、音视频、纯文本和 PDF 可内联，其余
  内容（包括 HTML、SVG、JavaScript、XML 和未知 MIME）以二进制附件下载。
  同时下发 `nosniff` 和沙箱 CSP。已存在的记录不需要重写。随机文件字节响应、
  WebDAV 文件下载和粘贴链接下载也不能转发远端任意响应头。
- 普通 Telegram 下载只转发范围和条件请求头，不转发站点 Cookie、Authorization
  或自定义 API 密钥。私有 Hugging Face 从仓库名和路径构造地址，不使用 metadata
  提供的下载 URL 发送 token；跳转到其他来源时移除 token。
- WebDAV 文件可附带非敏感布尔值 `WebDAVRequiresPassword`。它不参与账号摘要，
  允许更换密码，但要求对应配置仍有密码。仅有旧账号摘要且配置只有 Basic 用户名、
  无密码的情况会保守拒绝；确认是有意的无密码账号后，应使用带明确认证要求的新备份。
  索引重建不需要渠道在线，完整备份和恢复仍实施身份校验。
- Docker 中粘贴链接获取文件，以及随机/DAV 取外链字节时，不允许访问本机或私有
  网络；每个跳转都重新验证，连接使用经验证的 IP。不影响管理员显式配置的私有
  WebDAV/S3 存储。可设置 `FETCH_RES_ALLOWED_ORIGINS`，形如
  `https://images.example,https://cdn.example`，限制这些外部下载的初始来源及跳转来源。
  不要将不可信服务放在同一可信出口或直接将公开图库与管理应用共用不受控的 CDN。
- **部署时清理旧的文件响应缓存**（包括已有 CDN 缓存的 `/file/*` 和随机文件响应）。
  新代码不能撤销客户端已经收到的旧响应。直接返回原始对象的独立存储/CDN 域名
  不会经过本应用的响应策略，请隔离域名，不要让它承载管理应用的 Cookie。

以下命令验证编译后的 Worker，而不是替换路由依赖的单元测试。仅使用本地临时
KV/R2 和假渠道，不需要生产密钥。Windows 示例：

```powershell
$out = Join-Path $env:TEMP 'imgbed-review-worker'
npx --no-install wrangler pages functions build functions --outdir $out
node scripts/verify-file-boundaries.mjs (Join-Path $out 'index.js') 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

最后一个参数可省略：提供时启动独立的临时无头浏览器，验证上传的 HTML 和 JS
不会在页面中执行，并以成功解码 PNG 为对照。PR 检查运行 Node 22/24 的全量测试
及编译产物 HTTP 冒烟测试，不部署、不读取仓库 Secrets。

## 本轮全盘审查修复

- Docker 外链下载将非法 HTTP 状态/响应头转换异常收敛为 Promise 拒绝，销毁异常
  响应流，不再让异步事件回调抛错退出整个进程。
- 管理 API 按静态路由、方法和 action 判定权限。文件名中的 `list` / `delete`
  不参与权限选择；索引重建、合并、清除需要 `manage`，不能使用只读 token。
- MIME 只输出规范化的安全类型及单一 charset；拒绝带逗号/换行的歧义类型，
  不转发其任意参数。编译产物和真实浏览器覆盖伪装为 text/plain / image/png 的 JS。
- R2/S3/WebDAV 移动和重命名依次执行：复制对象、写目标记录、清理源对象、删源记录。
  WebDAV 使用非覆盖 COPY（不支持 COPY 的服务会安全失败，不回退到破坏性 MOVE）。
  复制或数据库写入失败时不删除源对象；源对象清理失败时新链接保持有效，响应携带
  `warnings` 并记录服务端日志。清理源对象期间保留源记录，防止正常上传命名逻辑
  提前复用该名称。源对象删除失败或结果不确定时不删除源记录；删除源记录失败时，
  新链接仍有效，旧记录需人工核对清理，不自动重试破坏性操作。S3 的 CopySource 按路径段编码。
- 存储与 KV/D1 之间没有分布式事务：故障时可能保留两个对象或两条记录。不要将
  网络超时理解为“肯定未写入”。检查两侧实际状态后再重试/清理，避免删除有效副本；
  WebDAV 的非覆盖 COPY 会拒绝直接覆盖故障留下的目标对象。
- Docker 在原生 fetch 边界清除已解压响应的 Content-Encoding 和旧 Content-Length；
  支持 gzip/x-gzip、deflate、br 及组合。Range 默认协商 identity；若远端仍返回
  压缩的部分响应则拒绝，避免伪造解压后字节范围。版本相关/未知编码保守拒绝，
  HEAD/304 和未解压的原始 HTTP 下载流不改动。Workers 不使用此 Node 专用适配层。

`test/securityReviewFixes.test.js` 覆盖真实 HTTP 解析器、压缩中继、完整 token 验证链、
KV/D1 × 两类移动操作 × 三类存储的复制/写入/删除故障注入。真实存储账号与完整 Docker
容器仍需部署环境联调；本地测试不能代替线上验证。原自动清理逻辑不变，未引入上游过期功能。

## 配置故障与并发上传回归

- 安全配置读取异常、JSON 损坏或认证字段结构非法时不再返回空认证配置。
  统一认证拒绝访问；登录、创建会话和文件访问等直接读取安全配置的链路会失败，
  而非降级为免认证。配置确实不存在时仍读取环境变量；明确配置为匿名的实例仍可使用。
- `test/reviewConcurrencyAuth.test.js` 使用 KV 和真实 SQLite/D1，验证管理员配置来自
  环境变量/数据库时的故障、匿名/有效 Token/有效会话拒绝、登录不生成会话，以及
  清理暂停期间真实上传处理器自动选用其他文件名，清理完成后可安全复用原名称。
- 删除对象与删除记录的测试同时覆盖“操作前失败”和“操作成功但确认丢失”。这些测试
  不意味着 KV、对象存储之间存在分布式事务或跨 Workers 锁；不要并发修改同一源文件。
