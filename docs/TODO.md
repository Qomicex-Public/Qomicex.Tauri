# 待办清单

> 最近核对：2026-09-09。已完成项与不采纳项见文末归档。

## 待办

（当前无活跃待办）

## 技术债备忘（ponytail 有意简化，非 bug，等真实痛点再升级）

- `src/lib/simple-cache.ts` / `src/api/skin.ts`：全局内存缓存无淘汰，内存敏感时需 LRU
- `src-tauri/src/ipc.rs:260`：导出响应整体缓冲进内存，大文件应走 `ipc_stream`
- `src/pages/Accounts.tsx:96`：shift-select 搜索变化时区间选择漂移（MVP 可接受）
- CI（debug.yml / release.yml）：QEMU 下 pnpm tarball 校验异常的 workaround
- `resource_center.rs:708`：「全部」聚合源 total 为各源之和（近似）；FTB 整合包分页已由 913616b 修复

## 归档（已完成 / 不采纳，勿重复立项）

| 项 | 结果 |
|----|------|
| Issue #86 主页插件组件位置重置 | 已修复，PR #91 合并（73d9361） |
| Issue #85 整合包 gameVersion 污染 | 已修复，PR #87 合并 |
| CF 在线整合包预览参数占位（原 modpack.rs:1312 TODO） | **不采纳**：install 管线下载 zip 后经 parse_curseforge_manifest 自动补全，安装完整可用；预览时提前下整个 zip 成本 > 收益 |
| mcmod 中文名 enrich（原 instance_files.rs:1001 TODO） | **已实现**（list_mods 442-479 行回填 + 前端 ModCard 消费），TODO 注释为过时残留已删 |
| skin.rs 换 axum Multipart（原 skin.rs:907 TODO） | **不采纳**：手写解析工作正常，换库是纯重构无行为变化 |
| FTB 翻页重复 | 已修复（913616b），聚合源 total 近似维持现状 |
| UpdateDialog 插件下载 cancel 语义 | 已随 b080e12 下载中心链路重写，待办失效 |
