# ADR-026：NeoForge 版本列表官方源失败时自动回退 BMCLAPI 镜像

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-20 |
| 决策者 | AI Agent |

## 背景

用户报告在下载新版本配置实例时，NeoForge 版本列表无法获取，必须挂梯子。分析发现 `InstallerProviderService::get_neoforge_versions` 在 `mirror == Official` 时仅请求官方 Maven API（`maven.neoforged.net`），失败时直接返回空列表，无任何回退机制。历史决策记录曾明确记载「不做官方源自动回退 BMCLAPI（跨子模块改动，另行评估）」。本次为解决国内网络下官方源不可达的问题，推翻该决策，实现官方源失败时自动回退 BMCLAPI。

## 决策

修改 `qomicex-core-rust/src/services/installers/provider.rs` 中的 `get_neoforge_versions`：当 `mirror == DownloadMirror::Official` 时，先并行请求官方 API 双端点（旧版 forge + 新版 neoforge）；若返回空列表（网络失败或解析失败均落入此分支），自动回退调用 BMCLAPI 接口 `https://bmclapi2.bangbang93.com/neoforge/list/{mcVersion}` 获取版本列表。BMCLAPI 分支保持原有逻辑不变。最终统一 `unwrap_or_default()` 保证失败时返回空列表而非 panic。

## 备选方案

### 方案 官方源失败时自动回退 BMCLAPI（已采纳）
- 优点：国内网络下用户无感知，自动可用；改动范围小，仅影响 NeoForge 版本获取路径；不破坏用户手动选择的镜像偏好。
- 缺点：官方源与 BMCLAPI 的版本列表可能存在细微差异（推荐标记、发布时间、版本去重规则）；若用户明确选择 Official 镜像，回退 BMCLAPI 可能违背其预期（但当前 UI 无单独 loader 镜像选择，全局 mirror 语义已包含 BMCLAPI 作为可用源）。
- 为何不选：直接解决用户报告的问题，符合启动器作为国内工具的产品定位。

### 方案 保留现状，仅提示用户手动切换下载源
- 优点：不推翻历史决策，行为可预期，无额外网络请求。
- 缺点：用户必须手动切换全局下载源才能获取 NeoForge 列表，体验差；与 Forge 等其他加载器的镜像策略不一致（Forge 已有 BMCLAPI 分支）。
- 为何不选：被动方案，未解决根本问题。

## 影响
- qomicex-core-rust/src/services/installers/provider.rs（get_neoforge_versions 逻辑修改）
- 后端 /api/loaders/versions 端点行为变更：Official 镜像下 NeoForge 列表现在具有自动回退能力
- 用户侧：国内网络环境下 NeoForge 版本列表获取成功率提升，无需手动切换镜像或挂梯子

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-20 | v1.0 | 初版创建 | AI Agent |