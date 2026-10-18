# 待办清单

> 最近核对：2026-10-09。已完成项与不采纳项见文末归档。
>
> ⚠️ **本文件是唯一事实源**。`docs/junsi-dev-docs/8-部署运维/TODO.md` 是文档索引内的指针，
> 不重复维护列表 —— 改待办请只改本文件。

## 待办（活跃）

### 由 2026-10-09 全项目 Review 产生

详见 [`2-架构设计/项目全景Review-2026-10.md`](junsi-dev-docs/2-架构设计/项目全景Review-2026-10.md)。

14 条（#225–#238；#239–#242 与 #233–#238 重复）**已全部处理**，见文末归档。
`#242` 中唯一保留待决策的一项：`tauri.conf.json` 的 `identifier` 仍为模板值
`com.tauri-app.qomicex-launcher` —— 决策与后续迁移要求见
[ADR-110](junsi-dev-docs/1-决策记录/ADR-110-保持tauri-identifier为模板值-com-tauri-app-qomicex-launcher-issue-238.md)。

### 由 2026-10-09 Review 产生（未建 issue，需人决策）

- **ADR 编号重复**：`ADR-015` ×2（版权隐私入口 / NAT 检测）、`ADR-102` ×2（Forge 加载器版本 / Technic SingleZip）。
  需决定是重编号还是加后缀，涉及 105 篇 ADR 的交叉引用。
- **ADR 编号缺失**：`003`、`041`、`056`、`057`、`058` 空缺。
- **前端无单测框架**：`playwright` 仅用于 `scripts/harness/`，需决定是否引入 vitest。
  现状：`scripts/test-*.mjs`（用仓库自带 tsc 编译真实源码后断言）已覆盖 deepLink / updateChannel /
  i18n 步骤键 / plugin 主题同步四处，属零依赖方案。
- **`src/theme/selfcheck.ts` 不受类型检查**（`tsconfig.json` 的 `exclude`）：该脚本用 `node:fs` 与
  `process`，而 tsconfig 面向 DOM，直接取消 exclude 会报 TS2307/TS2580（实测）。它可独立运行并通过
  （`node --experimental-strip-types src/theme/selfcheck.ts` 输出 `ok`）。若要纳入检查，需单独建
  一份带 `@types/node` 的 tsconfig。见 [ADR-109](junsi-dev-docs/1-决策记录/ADR-109-宿主Tailwind复用plugin-ui-preset-统一rounded-xl口径并收敛设置到DOM的双写-issue-238.md)。
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
| Issue #225–#238（14 条，含 #239–#242 重复项） | **已修复**（2026-10-10）：安全 #225/#226/#227、正确性 #228/#229/#230/#231/#232/#235、前端 #236、改进 #233/#234/#237/#238。方案见 ADR-109 / ADR-110，DTO 与端点变更已同步 `3-API规范/API列表.md` |
