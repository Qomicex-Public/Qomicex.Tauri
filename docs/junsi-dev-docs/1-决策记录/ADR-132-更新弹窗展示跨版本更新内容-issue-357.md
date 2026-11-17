# ADR-131：更新弹窗展示跨版本更新内容（issue #357）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-11-17 |
| 决策者 | AI Agent |

## 背景

用户从 1.0.x 直接升到 1.2.0 时，`UpdateDialog` / `UpdateCompleteDialog` 只显示**目标版本**一份 changelog。现状链路：

1. `scripts/generate-changelog.mjs` 的 `findPrevTag(vtag, releaseType)` 只取**同类型上一个 tag**，所以每份 notes 覆盖区间是「上一个同类型 tag..当前」。
2. `release.yml` 把这份 notes 同时写进 GitHub Release body、`latest.json.notes`、`updates.json.notes`。
3. 上游 `api.qomicex.top/api/client/update/plan` 原样透传该字段，启动器 `endpoints/update.rs` 的 `plan()` 也只带这一份。

于是跨多个版本升级时，用户只能看到最后一跳的改动。issue #357 要求显示跨度内所有版本。

**真正的缺口在上游**：`Web.Backend` 的 `versions` 表虽然有 `changelog` 列，但 `version-sync.ts` 的 `syncGithubVersions` 只对 `latestPerType(releases)` 落库（每条通道一行，为 Worker 50 次子请求预算做的收窄），历史全部丢弃。管理端「更新日志」页读的也是这张表，因此同样只有几条。

## 决策

**在上游补历史表 + 客户端端点，启动器只做代理与区间过滤。**

### 1. 上游新建 `release_history` 表（不塞进 `versions`）

`versions` 是 `/update/plan` 的**可推送候选集**，每条通道只该有最新一行；混入历史行会污染 `latest` 选择（ADR-085 刚因类型过滤出过事故）与管理端 Versions 页。历史只是展示数据，物理隔离：

```sql
CREATE TABLE release_history (
  version text PRIMARY KEY NOT NULL,
  type text NOT NULL,
  title text,
  notes text,
  published_at text,
  fetched_at text DEFAULT (datetime('now'))
);
```

### 2. 历史落库复用已有那 1 次 GitHub 请求

`syncReleaseHistory` 接收 `syncGithubVersions` 已经取到的 `releases` 数组，遍历写入 `version/type/title/body/published_at`，按 `version` 幂等 upsert。**刻意不读 `assets`、不下载签名**——子请求增量为 0，不会重开「预算被吃光导致 `/plan` 永远自愈不上」那个线上故障。

代价：单次同步上限 50 条（`per_page=50`）。不做翻页，理由同上；50 条覆盖常见升级跨度，启动器侧只取 10 条。

### 3. 新增 `GET /api/client/release-notes?channel=&limit=`

只读 D1，不实时打 GitHub（避免 429 与冷启动）。通道复用 `getAllowedTypes()`，与 `/version/check`、`/update/plan` 同口径——beta 用户不会看到 release 的历史。`notes` 按 UTF-8 字节截断到 8KB（按字节切会劈坏中文字符，必须逐字符累加）。

### 4. 启动器新增 `GET /api/update/changelog?current=&target=&channel=`

转发上游后做区间过滤：同列车内保留 `current < v <= target`（复用 `update_channel::is_train_upgrade`）。跨列车（用户切通道）时序数不可比，不做收敛，回上游原始顺序并由 `spanning` 说明这不是普通升级。展示上限 10 条，30 分钟进程内缓存（缓存**上游原始列表**而非过滤结果——区间随请求变化，缓存结果会让不同跨度的用户互相污染）。

### 5. 前端按参考设计渲染

`UpdateChangelog` 组件：版本段头（版本号 + 「最新」徽章 + 详情链接）+ 每条一行分类标签与正文；默认展开 3 个版本段，其余折叠成「还有 N 个更早的版本」。

分类来自 `generate-changelog.mjs` 的固定输出（`#### ✨ 新增功能` 等），由 `src/lib/updateHistory.ts` 解析。**解析失败返回 `null`**，调用方退回整段 markdown 渲染——最坏情况只是少了分类标签，不会出现空面板。

## 备选方案

### 方案 启动器直接聚合 GitHub（atom 取 tag + 逐 tag 拉 latest.json）

- 优点：不用改上游，不依赖 Web.Backend 部署
- 缺点：`api.github.com` 匿名限额按 IP 共享（本机实测 403）；atom 只给最近 10 条且 `?page=2` 实测返回同一页；逐 tag 拉 `latest.json` 是 N 次网络往返
- 为何不选：上游已有 GitHub token（5000/小时）和落库能力，把抓取放在启动器是重复建设且不可靠

### 方案 历史行直接写进 `versions` 表

- 优点：不用建表，管理端 Changelogs 页零改动
- 缺点：`versions` 是候选集，历史上百行后每次 `/update/plan` 都要全表过滤排序；且 `latestPerType` 的语义会被稀释
- 为何不选：ADR-085 的通道事故说明「候选集」这个不变量必须守住

### 方案 上游返回已过滤好的区间

- 优点：启动器零逻辑
- 缺点：上游不知道客户端展示上限，也无法复用 `update_channel`（TS 侧 `trainOf` 与 Rust 侧语义有历史分歧，见 ADR-085 v1.2 的大小写契约）
- 为何不选：区间过滤放启动器后端，与现有通道守卫同一套代码

## 影响

### Web.Backend（须先上线）

- `api/migrations/0009_release_history.sql` 新建表 + `published_at` 索引
- `api/src/db/schema.ts` 加 `releaseHistory`
- `api/src/utils/version-sync.ts` 加 `syncReleaseHistory`，`syncGithubVersions` 返回值多 `historySynced`
- `api/src/routes/client/release-notes.ts` 新增端点，`src/index.ts` 挂载
- `api/src/routes/admin/changelogs.ts` 改读新表（字段名沿用旧契约，管理页无需改）
- `api/src/utils/github.ts` 的 `GithubRelease` 补 `published_at?`

### 启动器

- `endpoints/update.rs` 加 `/update/changelog` 与 8 项区间过滤单测
- `src/api/update.ts` 加 `fetchUpdateChangelog`
- `src/lib/updateHistory.ts`、`src/components/UpdateChangelog.tsx`、`src/hooks/useUpdateChangelog.ts` 新增
- `UpdateDialog` / `UpdateCompleteDialog` 接入
- `scripts/test-update-history.mjs` + `test:update-history` + CI

### i18n

`qomicex-tauri-i18n` 7 语言的 `dialogs.update` 补 `historyTitle` / `latestBadge` / `viewDetail` / `moreOlder` / `hideOlder` / `historyTruncated` / `viewFullNotes` / `category.*`。

## 降级链（关键）

上游端点未部署或故障时，启动器 `/update/changelog` 返回 `{spanning:false, entries:[]}`，前端两个弹窗都退回**接入前的单块 changelog 渲染**。因此上游先上线不是硬阻塞：启动器可以先发版，界面行为与今天完全一致。

## 已知限制

- 历史窗口 50 条（单次 GitHub `per_page=50`），更早的版本需看发布页；`truncated` 字段会让 UI 提示这一点
- 历史表首次为空，需触发一次 `POST /api/internal/releases/sync` 回填
