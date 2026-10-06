<!--
PR 模板（markdown，非 issue form —— GitHub 的 issue form 不支持 pull request）。
标题请遵循 Conventional Commits：issue-triage.yml 会按标题前缀自动打 type: 标签。

  标题前缀 → 自动标签：
  feat → type: feature        fix/perf/refactor/revert → type: bug
  docs → type: docs           test/build/ci/style/chore → type: chore

PR 模板保持中英双语；删除中文不影响自动打标。
-->

## 变更类型 | Change Type

- [ ] 新功能 | New feature
- [ ] 缺陷修复 | Bug fix
- [ ] 性能 / 稳定性 | Performance / stability
- [ ] UI / 交互 / 样式 | UI / interaction / styles
- [ ] 插件系统 / plugin-ui | Plugin system / plugin-ui
- [ ] 联机（connector / SCF / EasyTier）| Multiplayer
- [ ] 更新通道 / Updater | Update channel / Updater
- [ ] 构建 / CI / 发布 | Build / CI / release
- [ ] 文档 | Documentation
- [ ] 重构 / 其它 | Refactor / other

## 背景 / 根因 | Background / Root Cause

<!--
说明「为什么改」：上游行为、复现路径、错误码、约束。
Explain the "why": upstream behavior, reproduction, error codes, constraints.
-->

## 改动 | Change

<!--
说明「改了什么」：范围、影响面、有意不做的部分。
What changed: scope, impact, deliberate non-goals.
-->

## 验证 | Verification

<!--
只写实际运行过的命令与结果。未运行请写明「未运行」及原因，不要勾选。
List commands actually run and their outcome. If not run, say so — do not check.
-->

- [ ] `pnpm run typecheck`（前端改动 | frontend）
- [ ] `pnpm run lint` / `pnpm run format:check`（如适用 | if applicable）
- [ ] `cargo fmt --manifest-path src-backend/qomicex-backend/Cargo.toml` + `cargo test`（后端改动 | backend）
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml` + `cargo test --lib plugin_gateway`（Tauri 改动 | Tauri）
- [ ] `pnpm --filter @qomicex/plugin-ui build`（plugin-ui 改动 | plugin-ui）
- [ ] `bash scripts/test-api-filters.sh`（后端端点改动 | backend endpoints）

## 风险 / 回滚 | Risk / Rollback

<!--
影响面、兼容性、数据迁移、回滚方式。
Impact, compatibility, data migration, rollback.
-->

## AI 使用披露 | AI Usage Disclosure

<!--
必须填写，见 AI_POLICY.md。不披露的 PR 会被打回。
Required — see AI_POLICY.md. Undisclosed use will be sent back.
-->

- 工具 / 模型 | Tool / model：
- 生成范围 | Generated scope：
- 人工验证方式 | Human verification：
- 我确认能解释全部改动 | I can explain every change：是 / 否 Yes / No

## 关联 Issue | Related Issues

<!-- 如 Closes #123 | e.g. Closes #123 -->

## 日志与附件 | Logs & Attachments

<!--
修复类 PR 请附导出日志（设置 → 日志 → 导出日志），便于回归对照。
For bug fixes, attach the exported log (Settings → Logs → Export).
-->

## 提交前确认 | Checklist

- [ ] 标题遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，无过程叙事 | Title follows Conventional Commits, no process narrative
- [ ] 已自行 review 全部改动，无调试代码、无无关格式化/重命名 | Self-reviewed; no debug code, no unrelated formatting/renames
- [ ] 提交信息只写根因 / 方案 / 验证，未包含「修法一/修法二」「CodeRabbit」「worktree」等过程元信息 | Commit message contains only root cause / approach / verification
- [ ] 注释只解释非显然的 why，未包含变更日志式注释 | Comments explain non-obvious "why" only
- [ ] 遵循仓库规范：本地 TS/TSX 导入带扩展名；`PathBuf`/`Path::join` 不硬编码路径 | Followed repo conventions
- [ ] 前端约定：React 19 严格模式、`cn()`、图标按钮 `Tooltip`、内部导航 `<Link>` | Frontend conventions honored
- [ ] Rust 侧已跑 `cargo fmt`（CI 会跑 `cargo fmt -- --check`）| Ran cargo fmt (CI enforces it)
