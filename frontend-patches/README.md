# 管理页发布产物补丁

仓库仅包含 `frontend-dist`，没有完整的 Vue 构建源码。`restoreProcessor.js`
从原有 `381` chunk 的 source map 恢复。补丁也覆盖管理页恢复完成后的动作：

1. 恢复 `sysConfig@upload` 渠道配置，失败则停止。
2. 恢复文件：后端验证渠道身份、移除历史凭据、确认索引更新已入队。
3. 恢复其他设置；任何文件或设置失败时保留当前登录，不应用备份的认证设置。
4. 最后恢复认证设置并跳转登录，不再用已经失效的 Cookie 发起重建。重新登录后正常列表读取会合并索引。

更新源码后运行：

```powershell
node scripts/patch-restore-order.mjs
npm test
```

脚本只替换现有 webpack bundle 中的 RestoreProcessor 类和恢复完成回调；更新 source map、
chunk/runtime 内容哈希以及 HTML 引用。重复运行无变化。若未来更换前端构建，
类名或模块布局变了，脚本会拒绝替换，需要先检查新产物，不要盲目放宽匹配。

`test/frontendRestore.test.js` 同时测试可读源码和 HTML 实际引用的编译产物，
并接入真实恢复 handler、KV 适配器和 SQLite 支撑的 D1 适配器。

`folderMutations.js` 让 Dashboard 的四处目录移动/删除调用在 D1 Workers 上自动续页，
仍使用原鉴权请求函数。任一页有失败项时，整次操作不会报告成功。
更新此脚本后运行 `node scripts/patch-folder-mutations.mjs`；它更新 Dashboard chunk、
runtime 和 HTML，并拒绝未知的调用点布局。`test/batchLifecycleRepairs.test.js`
验证 HTML 实际加载的补丁及真实 D1 handler 的分页行为。
