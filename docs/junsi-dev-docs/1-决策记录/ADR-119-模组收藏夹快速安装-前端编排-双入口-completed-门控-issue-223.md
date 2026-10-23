# ADR-119：模组收藏夹快速安装——前端编排、双入口、completed 门控（issue #223）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-23 |
| 决策者 | AI Agent |
| 关联 | issue #223、ADR-091（收藏持久化）、ADR-096（收藏夹分组）、ADR-112（前置计划纯函数）、ADR-118（分发受限） |

## 背景

issue #223 要求在已有收藏 / 收藏夹能力（#132）之上增加 mod 快速安装，两个入口：

1. **资源中心收藏夹视图**：把一个收藏夹内的全部 mod 一键安装到某个已有实例。
2. **新建版本向导**：选择收藏夹，实例安装完成后自动安装其中的 mod。

验收标准三条：两处 UI 可见、新建版本时可快速安装收藏夹资源、收藏夹页面可一键安装。

现状约束：

- 收藏数据由后端 JSON 持久化，`GET /resource-favorites` 一次返回全部收藏；收藏夹只是逻辑分组，成员关系挂在每条收藏的 `folderIds` 上（ADR-096）。
- 单资源安装链路是 `ResourceInstallDialog` → `getResourceVersions` / `getResourceDependencies` → `planDependencyInstall` → `quickInstallViaDownloadCenter`，后者创建 batch 任务并在后台聚合，不依赖组件存活。
- 新建实例链路是 `createInstance` → `startInstall`，后端在 `tokio::spawn` 里异步安装；SSE 里条目消失、进度到 100% 都**不代表**安装成功。
- `quickInstallViaDownloadCenter` 只接受**单个**主资源 + 依赖数组，且命名去重用的 `usedNames` 是函数内局部集合。

## 决策

### 1. 前端编排，不新增后端 API

复用既有 versions / dependencies / download 接口与 `quickInstall` 的批任务与聚合机制。新增后端任务 API 需要补齐目标文件预留、实例删除协调、重启恢复等保障，属大改且会变更公开 API，与最小改动原则冲突。

### 2. 三层结构：解析编排 → 纯函数规划器 → 批任务

- `src/lib/favoriteFolderInstallPlan.ts`：纯函数规划器。**不 import `src/types`**（与 ADR-112 同因：会把类型模块拉进编译程序，tsc 的 rootDir 上移导致产物路径与回归脚本约定不符）。
- `src/lib/favoriteFolderInstall.ts`：解析编排（固定并发 3，避免一次触发大量 90s 超时请求；单个资源失败只记跳过）+ 完成门控编排器。
- `src/lib/quickInstall.ts`：新增 `quickInstallViaDownloadCenterForFolder`，支持多主资源与外部传入的已用文件名集合；原函数签名与行为不变。

### 3. 身份与去重口径

- 身份是**来源 + 项目 ID**（`modrinth:abc` / `curseforge:12345`），绝不用文件名比较——本地名经命名模板重写，与上游名不同域，那正是 issue #249 的根因。
- **已安装的项目跳过，不重下、不替换、不删除**（ADR-112 同口径）。
- 根资源优先于依赖：同一项目既是收藏成员又是依赖时按根资源处理；共享依赖只下一次，保留首次出现的版本。
- `deletions` 恒为空：批量安装只做新增，绝不清除用户已有文件。

### 4. 命名去重在批任务的命名域里做

规划器输出的 `fileName` 是**上游原名**，原样透传。落盘名由 `quickInstall` 的命名阶段按 `fileNaming` 模板生成，去重也在那里完成（`existingFileNames` 参数把实例已有文件名作为全局预留的初始内容）。若在规划器里给上游名追加序号，批任务反推版本号的正则 `^.*-(\d[\w.+]*)$` 会把序号当版本号，生成 `xxx-2.jar` 这类错误文件名。

### 5. 新建实例以 `completed` 为门控，队列持久化 + 认领执行一次

- 待执行队列以 **instanceId 为键**持久化到 localStorage（`src/stores/pendingFavoriteInstallStore.ts`，手写 localStorage 与 `downloadStore.ts` 一致）。
- 编排器轮询 `getInstallProgress(instanceId)`，**只有 `completed` 才继续**；`failed` / `cancelled` 丢弃条目并提示；读不到进度时有限次重试（`NOT_FOUND_RETRIES`）后才放弃——不能把「后端还没登记」当成「实例不存在」。
- **不得**把 `installInstance` 返回、SSE 条目消失、进度 100%、步骤列表完成作为触发信号。
- 执行前先从队列**删除**条目再开始（认领），保证轮询与 `resumePending` 并发时只执行一次。
- 执行时重新读取实例信息取权威 `gameVersion` / `loader`，因为向导提交时的值可能被后端校正。
- 应用根组件（`App.tsx`）在后端就绪后调一次 `resumePendingFavoriteInstalls`，使刷新或重开启动器后仍能继续等待。

### 6. 安装范围是收藏夹的全部 mod 成员

不使用 `favoriteItems`（视图可见集合），因为它会随来源 / 分类 / 标签 / 搜索词变化；「安装此收藏夹」的语义是安装整个收藏夹，结果不应随搜索词改变。按钮只在 `favFolder` 为具体收藏夹 id 时出现，`all` 与 `UNFILED` 不显示。

## 已知限制

- **Modrinth 子依赖可能回退到不兼容版本**：后端依赖解析在找不到匹配版本时的回退策略不在本工单范围内。
- **CurseForge 子依赖不按 loader 过滤**：同上，属后端解析行为。
- **部分失败不回滚**：批任务里某个文件下载失败只让该 batch 标记 failed，已成功落盘的文件保留（与单资源安装一致）。
- **已安装判定只覆盖模组**：材质包 / 光影 / 数据包没有可靠的远程 id（core 反查仍为 UNMAPPED），不做名称猜测，因此这些类型的收藏不参与批量安装（记为 `notMod`）。

## 影响范围

新增：

- `src/lib/favoriteFolderInstallPlan.ts`、`src/lib/favoriteFolderInstall.ts`
- `src/stores/pendingFavoriteInstallStore.ts`
- `src/components/FavoriteFolderInstallDialog.tsx`
- `scripts/test-favorite-folder-install-plan.mjs`（27 项断言）

修改：

- `src/lib/quickInstall.ts`（新增多主资源导出函数；`aggregate` 改为显式接收依赖/本体两组任务 id，不再按位置切分——多本体时位置切分会把除最后一个之外的本体误算进依赖步骤）
- `src/pages/ResourceCenter.tsx`（收藏夹视图安装按钮 + 对话框）
- `src/pages/Instances.tsx`（配置步骤收藏夹下拉 + 提交后登记队列）
- `src/App.tsx`（启动时恢复待执行条目）
- `package.json`（`test:favorite-folder-install-plan`）
- `qomicex-tauri-i18n` 子模块（`resource.favorites.installFolder.*`、`instances.favoriteFolder.*`，7 语言）

不修改：后端 Rust 代码与收藏相关 API、`ResourceInstallDialog.tsx`、`planDependencyInstall` 的既有契约。

## 验证

- `pnpm run typecheck` 通过
- `pnpm run lint`：0 error / 102 warning（与 AGENTS.md 基线一致，新增 0 条）
- `pnpm run build` 通过
- `pnpm run test:favorite-folder-install-plan`：27 项断言通过
- `pnpm run test:dependency-install-plan`：10 项断言通过（无回归）
- `pnpm run test:i18n-steps`：7 语言覆盖 25 step id + 27 stage
- `pnpm run license:check`：389 个源文件均声明版权头
