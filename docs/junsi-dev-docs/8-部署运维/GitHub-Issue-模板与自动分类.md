# GitHub Issue / PR 自动 Type 分类（标签体系 + 自动打标 + opencode 兜底 triage）

最后更新：2026-09-27

## 1. 背景与根因

**现象**：用户在 Issue 页面选择了「Bug 反馈 / 新功能建议 / 优化建议」模板并提交，但 Issue 创建后**没有任何标签**，后期也无法按类型筛选（实测 #101 / #112 / #114 / #116 / #117 全部 0 label）。

**根因**（GitHub 官方文档 `syntax-for-issue-forms`）：

> "Labels that will automatically be added to issues created with this template. **If a label does not already exist in the repository, it will not be automatically added to the issue.**"

三个 issue form 模板的 front matter 写的是 `labels: ["bug", "needs-triage"]` / `["enhancement", "needs-triage"]` / `["improvement", "needs-triage"]`，而仓库里只有 GitHub 默认标签（`Bug / Enhancement / Documentation / Duplicate / Fixed / Processing / invalid / question / wontfix / good first issue / help wanted`），**大小写与命名都不匹配** → GitHub 静默忽略，前端无任何报错。

另外两个未被利用的能力：

1. org `Qomicex-Public` 已开启原生 **Issue Types**（`Task` / `Bug` / `Feature`），issue form 支持 `type:` 前置键自动写入，之前完全没用上 —— 这正是用户所说的「Type」。
2. issue form 的 `title:` 前置键可以预置类型前缀，为自动打标提供稳定的机读判据。

## 2. 方案：三层兜底

| 层 | 载体 | 职责 | 失效条件 |
|---|---|---|---|
| ① 模板层 | `.github/ISSUE_TEMPLATE/*.yml` | `labels:` 自动打标签 + `type:` 写原生 Issue Type + `title:` 预置前缀 | 标签不存在；非模板 Issue |
| ② 自动化层 | `.github/workflows/issue-triage.yml` | 确定性打标/互斥校正、PR 按 Conventional Commits 打标、`workflow_dispatch` 补录 | 无（纯 API） |
| ③ 兜底层 | 同上的 `opencode fallback classification` step | 上两层判不出类型（空白 Issue / 无前缀标题）时用 opencode CLI 分类并补 `type:` / `area:` | `vars.ISSUE_TRIAGE_ENABLED=off`、缺 `OPENCODE_API_KEY`、模型不可用（均静默降级） |

① 依赖 ② 之外的**标签存在性**，由 `.github/labels.yml` + `.github/workflows/label-sync.yml` 保证：label-sync 在 main 分支且本文件变更时自动把标签同步到仓库。

## 3. 标签体系（`.github/labels.yml`）

三个命名空间，`type:` 互斥，`status:` 由维护者手工维护，`area:` 可多个。

| 前缀 | 取值 | 颜色 |
|---|---|---|
| `type:` | `type: bug` / `type: feature` / `type: improvement` / `type: docs` / `type: question` / `type: discussion` / `type: chore` | d73a4a / a2eeef / 84b6eb / 0075ca / d876e3 / c5def5 / ededed |
| `status:` | `needs-triage` / `in-progress` / `blocked` / `duplicate` / `wontfix` / `invalid` / `fixed` | fbca04 / 1d76db / b60205 / cfd3d7 / ffffff / e4e669 / 818bd4 |
| `area:` | `frontend` / `backend` / `connector`（联机） / `updater` / `plugin` / `ci` / `docs` / `i18n` | 5319e7 |

维护规则：

- **只改 `.github/labels.yml`**，不要在 GitHub UI 手工建/改标签；push 到 main 即自动同步（也可 `Actions → Label Sync → Run workflow`）。
- 新增标签必须同步补进 `.github/workflows/issue-triage.yml` 的 `ALLOWED_TYPE` / `ALLOWED_AREA` 白名单，否则 opencode 兜底打不上。
- `delete-other-labels: false`，GitHub 内置标签（Bug/Enhancement/…）保留不动，存量 Issue 不会掉标签。

## 4. 模板映射

| 模板文件 | `type:` | `title:` | 自动 labels |
|---|---|---|---|
| `bug_report.yml` | `Bug` | `[Bug] <title>` | `type: bug`, `status: needs-triage` |
| `feature_request.yml` | `Feature` | `[Feature] <title>` | `type: feature`, `status: needs-triage` |
| `improvement_suggestion.yml` | `Task` | `[Improvement] <title>` | `type: improvement`, `status: needs-triage` |

原生 Issue Type 只有三种，优化建议归入 `Task`，真正的类型区分由 `type:` 标签承担。

## 5. `issue-triage.yml` 触发条件与行为

```
on:
  issues:              [opened, reopened, edited]
  pull_request_target: [opened, reopened, edited]
  workflow_dispatch:   inputs.issue_number（补录单个 issue；留空 = 批量模式）
```

`permissions: contents: read / issues: write / pull-requests: write`；`pull_request_target` 只调用 API 打标，**不 checkout 也不执行 PR 代码**。同一 issue/PR 的并发取消（`concurrency: triage-<number>`）。

### Job `triage`（单个目标）

| Step | 实现 | 行为 |
|---|---|---|
| `Resolve target issue` | `actions/github-script@v9` | 解析编号（dispatch 输入 / issue / PR）→ `issues.get` → 输出 `number/is_pr/is_bot/has_type`，并把元数据+正文写入 `$RUNNER_TEMP/issue.md` |
| `Deterministic type label` | `actions/github-script@v9` | 判据优先级：① 标题前缀 `^\[Bug\]` / `^\[Feature\]` / `^\[Improvement\]`；② issue 正文 marker：`### QML 版本号`、`### 复现步骤`→bug，`### 功能描述`→feature，`### 优化类型`→improvement；③ PR 标题 Conventional Commits 前缀：`feat/feature→type: feature`，`fix/perf/refactor/revert→type: bug`，`docs→type: docs`，`test/build/ci/style/chore→type: chore`。命中则补目标标签、移除其它 `type:`（互斥）、issue 若无 `status:` 则补 `status: needs-triage`；幂等，无变更则零 API 写 |
| `opencode fallback classification` | bash + `opencode run` | 仅当：非 PR 事件、非机器人、当前无 `type:` 标签、上一步未命中、`vars.ISSUE_TRIAGE_ENABLED != 'off'`。安装 opencode CLI → 非交互 `opencode run --model $MODEL -f issue.md "$(cat .github/opencode/issue-triage.md)"` → 用内联 `node -e` 从日志抓最后一个带 `type` 字段的 JSON 代码块。`continue-on-error: true`，失败只写日志 |
| `Apply opencode classification` | `actions/github-script@v9` | 仅取白名单内的 `type:`/`area:` 且标签确实存在才补（**只加不删**，确定性结果优先）；`duplicate_of` 为有效且处于 open 的 issue 编号时，才发一条「疑似重复」评论并打 `status: duplicate` |

`anomalyco/opencode/github@latest` 的 action 内部 `assertContextEvent("issue_comment", "pull_request_review_comment")`，**只能在评论事件运行**，所以「Issue 打开即自动分类」必须走 CLI 模式（本方案即如此）；评论触发的 `/oc` `/opencode` 仍由 `.github/workflows/opencode.yml` 承担，未改动。

### Job `backfill`（批量补录）

`workflow_dispatch` 且 `issue_number` 留空时运行：列出所有 open 且无 `type:` 标签的 issue（排除 PR），取前 20 个补 `status: needs-triage`。要拿到完整 `type:` 分类，请对每个 issue 单独 `workflow_dispatch` 填编号（走 `triage` job 的三步全链路）。

## 6. 配置项

| `opencode fallback classification` | bash + `opencode run` | 仅当：非 PR 事件、非机器人、当前无 `type:` 标签、上一步未命中、`vars.ISSUE_TRIAGE_ENABLED != 'off'`。安装 opencode CLI → 非交互 `opencode run --model $MODEL -f issue.md "$(cat .github/opencode/issue-triage.md)"` → 用内联 `node -e` 从日志抓最后一个带 `type` 字段的 JSON 代码块。`continue-on-error: true`，失败只写日志 |
|---|---|---|
| Secret | `OPENCODE_API_KEY` | opencode 账号密钥，与 `.github/workflows/opencode.yml` 共用同一个 |
| Variable | `ISSUE_TRIAGE_MODEL` | 覆盖分类模型，默认 `opencode/nemotron-3-ultra-free` |
| Variable | `ISSUE_TRIAGE_ENABLED` | 设为 `off` 一键关闭 opencode 兜底（确定性打标不受影响） |

## 7. 维护须知（改模板前必读）

- **改模板的 `label:`/字段名必须同步 `issue-triage.yml` 的判据**：Step 1 的 `ISSUE_BODY_MARKERS` 是精确字符串匹配 issue form 渲染后的 markdown 标题（`### QML 版本号` 等）。标题判据（`^\[Bug\]`）为主，正文 marker 为备。
- `blank_issues_enabled: false`（`.github/ISSUE_TEMPLATE/config.yml`）堵住「绕过模板直接建 Issue」这条路；排障需要建空白 Issue 时可用 `gh issue create` 或临时开启。
- `contact_links` 只写仓库真实存在的入口（官网 homepage、安全通告），**不要写 Discussions**——本仓库未开启 Discussions。
- **改模板的 `labels:` 与字段名必须同步 `issue-triage.yml` 的判据**：Step 1 的 `ISSUE_BODY_MARKERS` 是精确字符串匹配 issue form 渲染后的 markdown 标题（`### QML 版本号` 等）。标题判据（`^\[Bug\]`）为主，正文 marker 为备。

## 8. 排障

| 症状 | 排查 |
|---|---|
| Issue 仍然没有 `type:` 标签 | ① 确认 Actions → Label Sync 跑过且标签已存在；② 走的是哪个模板、标题是否被修改过前缀；③ 空白 Issue 看 `Actions → Issue & PR Triage` 日志里 `opencode exit:` 与 `parsed=` |
| Actions 里看不到 triage 运行 | 非 issues / pull_request_target 事件不触发（如 push、issue_comment） |
| opencode 步骤被跳过 | `vars.ISSUE_TRIAGE_ENABLED=off`、issue 已有 `type:` 标签、作者是 Bot、或目标为 PR |
| opencode 步骤失败但 Job 仍绿 | 设计如此（`continue-on-error`）；看日志 `classify.log` 尾部确认是网络/密钥/模型问题 |
| 想给历史 issue 补分类 | `Actions → Issue & PR Triage → Run workflow` 填 `issue_number` |

## 9. 相关文件

- `.github/labels.yml`、`.github/workflows/label-sync.yml`
- `.github/workflows/issue-triage.yml`、`.github/opencode/issue-triage.md`
- `.github/ISSUE_TEMPLATE/{bug_report,feature_request,improvement_suggestion,config}.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`、`.github/dependabot.yml`
- `.github/workflows/opencode.yml`（评论触发 `/oc`，未改动）、`.github/workflows/ocr-review.yml`（PR 审查，仅 `github-script` 升版）
