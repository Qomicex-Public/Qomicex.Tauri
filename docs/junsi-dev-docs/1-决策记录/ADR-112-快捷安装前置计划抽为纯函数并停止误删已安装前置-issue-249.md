# ADR-112：快捷安装前置计划抽为纯函数并停止误删已安装前置（issue #249）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-12 |
| 决策者 | AI Agent |

## 背景

issue #249 报告：Fabric 实例上先安装模组 A，再安装「需要前置的第二个模组」，第二步骤的前置（含 fabric-api）被全部删除，且安装后不下载任何前置文件。

根因（已证明）在 `src/components/ResourceInstallDialog.tsx` 的依赖循环：

```ts
const existing = installedByProjectId.get(dep.projectId)
if (existing) {
  if (existing.fileName !== dep.fileName)      // ← 恒为 true
    toDelete.push({ fileName: existing.fileName, category: dep.category })
  continue                                      // ← 跳过下载
}
```

**两个命名域被混用**：
- `existing.fileName` 是**本地落盘名**，经命名模板（ENH-10，默认 `[{cn}]{name}-{version}`）重命名，如 `[Fabric-API]Fabric-API-0.162.0+26.3.jar`；
- `dep.fileName` 是**上游原名**，由后端 `resource_center.rs` 的 `file_name: primary_file.filename` 下发，如 `fabric-api-0.162.0+26.3.jar`。

二者必然不等 → 每个「已安装」的前置都被无条件 push 进 `toDelete`，同时下载分支被 `continue` 跳过。`quickInstall` 的 `aggregate` 只在**全部下载成功后**执行删除（ADR-090 的设计），于是删除照常发生、补下载从未发生 —— 一个根因同时解释两个症状。

实测证据：
- 事发实例真实缓存 `C:\qomicex-launcher\QML\mods-cache\937a7342-508-mods.json`（issue 日志中 `game started instance=937a7342-508`）18 条，本地名与上游名不同域；
- 探针实跑 `formatDownloadFileName('[{cn}]{name}-{version}')` 复现不等；
- 用该缓存重放：旧逻辑删除 1 个真实在盘文件，修复后删除名单为 `[]`。

## 决策

1. **已安装的前置：既不重下、也不删除。** 判定按远程 `projectId`；清理名单对依赖恒为空。本地名与上游名分属两个命名域，不能用来判定「过期」——要判定过期只能比对远程版本 id（`modrinthVersionId` / `curseForgeFileId`），那属于版本切换功能的职责，不应由「安装前置」顺手做破坏性动作。此口径与 ADR-101「已装即满足依赖、不校验版本区间」一致，且本对话框的 UI 只对**未安装**的依赖展示版本选择器，用户本就无从指定要替换成哪个版本。
2. **把计划抽成纯函数** `src/lib/dependencyInstallPlan.ts` 的 `planDependencyInstall(deps, installedByProjectId, selected)`，返回 `{ downloads, deletions }`。抽出的理由是**让契约可断言**：该判定此前埋在 `ResourceInstallDialog` 的 `useCallback` 里，只能靠人读代码发现；线上表现为破坏性行为（删用户文件）却无任何测试覆盖。
3. **回归脚本沿用仓库既有约定**（`scripts/test-update-channel.mjs` / `test-deep-link-parse.mjs`）：用仓库自带 tsc 编译**真实源码**到临时目录后断言，不引入测试框架、不抄一份逻辑自证；并接入 CI 的 `frontend-lint` 作业。
4. **纯函数不 `import type` 业务类型**：改用具结构化类型 `DependencyLike`（只声明 projectId/downloadUrl/fileName/category/name）。引入 `src/types/index.ts` 会把整个类型模块拉进编译程序，tsc 推断的 rootDir 由 `src/lib` 上移为 `src`，产物落成 `lib/xxx.js`，与既有回归脚本「平铺产物」的约定不符（实测已复现该 emit 形状）。

## 备选方案

### 方案 比对远程版本 id 后先下新版再删旧
- 优点：能自动把过期前置升级到匹配版本
- 缺点：需放开已安装项下载、改动面扩到 UI 与 quickInstall；用户无法选择目标版本，可能把可用前置降级
- 为何不选：破坏性变更风险高于 bug 本身，且超出 issue 报告的范围

### 方案 顺带修正 installedNames 的显示层域不一致
- 优点：消灭一处同类隐患
- 缺点：该处已被 OR 短路，当前不可见；扩大 diff 与评审面
- 为何不选：范围外缺陷，按规范仅报告不擅自修

## 影响
- src/components/ResourceInstallDialog.tsx（依赖安装计划改走纯函数，删除恒真的文件名比较）
- src/lib/dependencyInstallPlan.ts（新增：planDependencyInstall + 结构化类型）
- scripts/test-dependency-install-plan.mjs（新增：10 项断言，含真实 incident 数据形状）
- package.json（新增 test:dependency-install-plan 脚本）
- .github/workflows/ci.yml（frontend-lint 作业接入新回归脚本）
- docs/junsi-dev-docs/2-架构设计/模组快捷安装管线.md（同步修复后的依赖处置口径）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-12 | v1.0 | 初版创建 | AI Agent |