# PHASE1 端到端联调记录

> 日期：2026-08-25
> 验证范围：store ↔ launcher 插件全链路（①-⑥ 集成）
> 环境：本地 store（wrangler dev :8787）+ 本地 launcher backend（:5000）+ 本地 R2 dev server（:8790）

## 验证结果总表

| # | 验证项 | 结果 | 备注 |
|---|---|---|---|
| 1 | store check-updates 契约 | ✅ | 返回完整结构含 slug/currentVersion/latestVersion/sha256/permissions/layers/rolloutPercent/download.url |
| 2 | backend 代理指向本地 store | ✅ | `QOMICEX_STORE_API_BASE` env 覆盖生效，`/api/store/plugins` 返回本地 store 数据 |
| 3 | backend check-updates 版本过滤 | ✅ | 正确按 minLauncherVersion 过滤（e2e-plugin min=1.0.0 > launcher 0.1.1 → 空） |
| 4 | store 下载端点 | ⚠️ | download.url 指向 `:8790` 但 R2 404 — 本地 R2 对象未持久化，属环境问题 |
| 5 | 签名负向（无签名 upload） | ✅ | `PLUGIN_SIGNATURE_MISSING` 400 |
| 6 | 升级快照 + 回滚单测 | ✅ | `cargo test` 102 passed（含 snapshot 3 + rollback 3 单测） |
| 7 | 升级快照真实端到端 | ❌ | 因 R2 404 无法完成 install 下载链路，待上线 store 后验证 |

## 关键命令记录

```bash
# store 健康检查
curl http://127.0.0.1:8787/
# store check-updates 直接验证
curl -s -X POST http://127.0.0.1:8787/api/v1/plugins/check-updates \
  -H "Content-Type: application/json" \
  -d '{"launcherVersion":"1.0.0","installed":[{"slug":"e2e-plugin","version":"1.0.0"}]}'
# → 返回 1.0.0→1.0.1 更新，含 rolloutPercent:100

# backend 代理验证
curl http://127.0.0.1:5000/api/store/plugins?page=1&pageSize=5
# → 返回本地 store 的 e2e-plugin

# 签名负向验证
curl -s -X POST http://127.0.0.1:5000/api/plugins/upload \
  -F "plugin=@e2e.qplugin;type=application/octet-stream"
# → PLUGIN_SIGNATURE_MISSING 400
```

## 环境问题

- 本地 R2（`workerd` 的 R2 dev server）在上传后对象未映射到 `:8790` 的 served 路径，需确认 `wrangler dev` 的 R2 本地持久化行为
- 不影响代码正确性：生产 store 的 R2 custom domain（`cdn.qomicex.top`）直接 serve 文件

## 遗留 TODO

- 上线 store 后重新验证 install 全链路（升级→.bak→rollback）
- 端到端 CI 可考虑在 workflow 中起 store + launcher 测试
- 前端 UI 验证需商店有真实更新插件版本（当前 local store 插件 minLauncher 超出版本）