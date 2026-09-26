<!--
PR 模板（markdown，非 issue form —— GitHub 的 issue form 不支持 pull request）。
标题请遵循 Conventional Commits：issue-triage.yml 会按标题前缀自动打 type: 标签。
  标题前缀 → 自动标签：
  feat → type: feature        fix/perf/refactor/revert → type: bug
  docs → type: docs           test/build/ci/style/chore → type: chore
-->
<!-- PR 模板请保持中英双语，删除这里的中文不会影响自动打标。 -->

## 📌 变更类型 | Change Type

<!-- 勾选适用的选项 | Check applicable items -->

- [ ] ✨ 新功能 | New feature
- [ ] 🐛 缺陷修复 | Bug fix
- [ ] ⚡ 性能 / 稳定性 | Performance / stability
- [ ] 🎨 UI / 交互 / 样式 | UI / interaction / styles
- [ ] 🧩 插件系统 / plugin-ui | Plugin system / plugin-ui
- [ ] 🌐 联机（connector / SCF / EasyTier）| Multiplayer (connector / SCF / EasyTier)
- [ ] 🔄 更新通道 / Updater | Update channel / Updater
- [ ] 📦 构建 / CI / 发布 | Build / CI / release
- [ ] 📝 文档 | Documentation
- [ ] ♻️ 重构 / 其它 | Refactor / other

## 🔍 变更说明 | Description

<!--
说明「做了什么」与「为什么」。大改动请拆成可审查的小 PR。
What does this change and why? Split large changes into reviewable PRs.
-->

## 🧪 测试情况 | Testing

<!--
跑过的检查与结果；Rust/TS 改动请至少跑对应的 typecheck / cargo fmt / cargo test。
Checks you ran and their outcome; Rust/TS changes should at least pass typecheck / cargo fmt / cargo test.
-->

- [ ] `pnpm run typecheck`（前端改动）
- [ ] `cargo fmt -- --check` + `cargo test`（Rust 改动）
- [ ] `bash scripts/test-api-filters.sh`（后端端点改动）
- [ ] `pnpm --filter @qomicex/plugin-ui build`（plugin-ui 改动）

## 🔗 关联 Issue | Related Issues

<!-- 关联的 Issue 编号，如 Closes #123 | e.g. Closes #123 -->

## 📎 日志与附件 | Logs & Attachments

<!--
问题修复类 PR 请附导出日志（设置 → 日志 → 导出日志），便于回归对照。
For bug fixes, attach the exported log (Settings → Logs → Export) for later comparison.
-->

## ✅ 提交前确认 | Checklist

- [ ] 标题遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) | Title follows Conventional Commits
- [ ] 已自行 review 全部改动，无调试代码与无关改动 | Self-reviewed; no debug code or unrelated changes
- [ ] 遵循仓库规范：本地 TS/TSX 导入带 `.ts` 扩展名；`PathBuf`/`Path::join` 不硬编码路径 | Followed repo conventions (TS imports with extensions, no hardcoded paths)
- [ ] React 19 严格模式 / `cn()` / `Tooltip`（图标按钮）等前端约定已遵守 | Frontend conventions honored
- [ ] Rust 侧已跑 `cargo fmt`（CI 会跑 `cargo fmt -- --check`）| Ran cargo fmt (CI enforces it)
