# 待办清单

> 最近核对：2026-10-09。已完成项与不采纳项见文末归档。
>
> ⚠️ **本文件是唯一事实源**。`docs/junsi-dev-docs/8-部署运维/TODO.md` 是文档索引内的指针，
> 不重复维护列表 —— 改待办请只改本文件。

## 待办（活跃）

### 由 2026-10-09 全项目 Review 产生（已建 issue）

详见 [`2-架构设计/项目全景Review-2026-10.md`](junsi-dev-docs/2-架构设计/项目全景Review-2026-10.md)。

| Issue | 主题 | 优先级 |
|:---|:---|:---|
| [#225](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/225) | 插件安装路径穿越：`install_from_dir` 未校验 `manifest.id` | P0 安全 |
| [#226](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/226) | `plugin_file` 路径守卫无效：`Path::starts_with` 按组件前缀比较 | P0 安全 |
| [#227](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/227) | 插件 CORS 代理 SSRF：`proxy_client` 允许重定向且不逐跳重校验 | P0 安全 |
| [#228](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/228) | `DownloadManager` 热替换后 OnceLock 单例失联（Java / 整合包 / 资源下载） | P1 正确性 |
| [#229](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/229) | 下载与安装任务注册表无界增长，SSE 持续重播历史任务 | P1 正确性 |
| [#230](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/230) | 进度端点契约不一致：`install/progress` 缺 6 字段、`complete/progress` 恒为 0 | P1 正确性 |
| [#231](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/231) | 取消启动杀不掉 JVM 子进程树 | P1 正确性 |
| [#232](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/232) | 整合包 addon 解析静默吞错，依赖装失败仍报安装成功 | P1 正确性 |
| [#235](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/235) | IPC 帧上限 1 GiB 与整帧 30s 读超时冲突 | P1 正确性 |
| [#236](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/236) | 插件主题同步泄漏：`registerThemeSync` 丢弃 unsubscribe | P1 正确性 |
| [#239](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/239) | 世界预览：会话全局单例 + `count_regions` 整文件读入内存 | P2 优化 |
| [#240](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/240) | 游戏日志缓冲 `Vec::remove(0)` 导致长会话 O(n²) | P2 优化 |
| [#241](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/241) | 死代码清理：`/api/launch`、`api/launcher.ts`、两处未使用的 hook | P2 优化 |
| [#242](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/242) | 重复定义与配置漂移：权限表、Tailwind 配置、主题变量写入、工程配置 | P2 优化 |

### 由 2026-10-09 Review 产生（未建 issue，需人决策）

- **ADR 编号重复**：`ADR-015` ×2（版权隐私入口 / NAT 检测）、`ADR-102` ×2（Forge 加载器版本 / Technic SingleZip）。
  需决定是重编号还是加后缀，涉及 105 篇 ADR 的交叉引用。
- **ADR 编号缺失**：`003`、`041`、`056`、`057`、`058` 空缺。
- **`AGENTS.md` 的 ADR 起始号滞后**：写「新增从 086 起」，实际已到 108。
- **`tauri.conf.json` 的 `identifier`** 仍是模板值 `com.tauri-app.qomicex-launcher`。
  它决定数据目录身份，改动等于让老用户配置「搬家」—— 需确认「保持」还是「迁移」。
- **前端无单测框架**：`playwright` 仅用于 `scripts/harness/`，需决定是否引入 vitest。
- **全量 Prettier**：`prettier --check .` 有 522 个文件不符，必须作为一次独立的 `style:` 提交排期。

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
| 源码注释 ADR 引用错位（5 组 20+ 处） | **已修复**（2026-10-09）：081→085、087→100、103→105、082→084、4 处补 100 |
| `模块划分.md` / `完整项目架构图.md` / `构建部署.md` / `技术选型.md` 过时 | **已修复**（2026-10-09）：移除 C# 时代内容，计数改为实测值 |
