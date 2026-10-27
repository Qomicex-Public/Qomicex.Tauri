# Changelog

发布说明由 `scripts/generate-changelog.mjs` 从提交历史生成，随 release 一并发布。
本文件只记录尚未发布的改动；已发布版本见
[GitHub Releases](https://github.com/Qomicex-Public/Qomicex.Tauri/releases)。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- 移除未被运行时引用的 `public/mcmod_data.json` 与 `plugins-dev/hello-plugin/package-lock.json`。
- Prettier 忽略子模块目录；`Qomicex.Updater` 子模块地址改为 HTTPS。
- 修正后端模块头中与实现不符的 501 占位描述，清理 7 处无 issue 号的 TODO。
- 依赖升级：vite 7.3.7；传递依赖 source-map-js 1.2.2、postcss-selector-parser 7.1.6。

### 修复

- 修复 27 个 ESLint error，其中 3 处为 `react-hooks/rules-of-hooks` 违规。
- 修复测试目标中一个被嵌套在 `#[test]` 内、从未执行的用例。
- 清理 105 条 clippy 告警（冗余 borrow、可折叠分支、循环内编译正则等）。
- 修复游戏目录搬迁（如 `.minecraft` 从 C: 换到 E:）后实例设置被重建为默认值、
  JVM 参数丢失导致整合包无法启动的问题。仅在旧目录确认不存在、元数据兼容且来源
  唯一时接管，尊重用户显式清空，配置写失败保留旧记录；MMC 导入的 JVM 参数落盘
  失败不再被静默忽略。
