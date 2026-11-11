# 管理页发布产物补丁

仓库仅包含 `frontend-dist`，没有完整的 Vue 构建源码。`restoreProcessor.js`
从原有 `381` chunk 的 source map 恢复，保留原类接口，只修复恢复顺序和进度统计：

1. 恢复 `sysConfig@upload` 渠道配置，失败则停止。
2. 恢复文件，让后端先验证渠道身份再移除历史凭据。
3. 最后恢复其他设置，避免提前启用管理员认证而打断空实例的导入。

更新源码后运行：

```powershell
node scripts/patch-restore-order.mjs
npm test
```

脚本只替换现有 webpack bundle 中的 RestoreProcessor 类；更新 source map、
chunk/runtime 内容哈希以及 HTML 引用。重复运行无变化。若未来更换前端构建，
类名或模块布局变了，脚本会拒绝替换，需要先检查新产物，不要盲目放宽匹配。

`test/frontendRestore.test.js` 同时测试可读源码和 HTML 实际引用的编译产物，
并接入真实恢复 handler、KV 适配器和 SQLite 支撑的 D1 适配器。

`folderMutations.js` 让 Dashboard 的四处目录移动/删除调用在 D1 Workers 上自动续页，
仍使用原鉴权请求函数。任一页有失败项时，整次操作不会报告成功。
更新此脚本后运行 `node scripts/patch-folder-mutations.mjs`；它更新 Dashboard chunk、
runtime 和 HTML，并拒绝未知的调用点布局。`test/batchLifecycleRepairs.test.js`
验证 HTML 实际加载的补丁及真实 D1 handler 的分页行为。
