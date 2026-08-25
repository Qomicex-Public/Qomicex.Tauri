# ADR-049 插件生态战略——进程隔离/主题语义化/签名验证/DX 工具链

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-25 |
| 决策者 | AI Agent |

## 背景

Qomicex Launcher 从 0.5 走向 1.0 的关键一跃：对标 VS Code 生态范式，构建插件扩展系统与主题系统。当前已有内联渲染（默认）+ iframe 沙箱（l2）+ WASM 网关（l3, wasmtime）三层插件架构，主题基于 HSL CSS 变量+light/dark+Catppuccin 预设，商店基于 Cloudflare Worker+Hono+D1+R2 且已实现设备流认证/组织/审核/限流。但存在 10 项技术债：内联默认→冻结炸弹、无签名验证、无更新灰度、theme.css 全局污染、无 CI 热重载链等。本 ADR 围绕四大支柱（进程隔离/主题语义化/市场签名验证与可持续/DX 工具链）制定一次性全量规划，分 Phase 0.5→1 和 Phase 1→1.5 两阶段落地。

## 决策

1. 插件默认渲染从内联切换为 iframe(l2)，禁止插件主线程重计算（强制 Web Worker/WASM/后端），Phase 1 引入 l4 远程 WebView 作为可选重 UI 隔离层。2. 主题升级为三级语义 token（primitive→semantic→component）+ `.qtheme` 包格式含三贡献类型（颜色/图标/字体），plugin-ui 组件只消费 `var(--*)` 实现即时换肤。3. 市场引入 Ed25519 三级签名链、semver 依赖冲突检测、灰度通道(stable/beta/alpha)、R2 直连下载（零 Worker 请求/字节），Phase 1 发布开放注册表规范。4. DX 工具链：`qomicex` CLI (create/dev/pack/verify/publish) + Playwright harness 热重载 + AI skill 包。

## 备选方案

### 方案 方案A（已选）：iframe 默认 + 主线程计算禁令 + Phase 1 渐进 l4 远程 WebView
- 优点：代价低（已有框架），隔离充分，渐进引入
- 缺点：iframe 不解决 freeze；远程 WebView 增加窗口管理复杂度
- 为何不选：最低成本解决 DOM/CSS 隔离，计算禁令防 freeze 最低限，l4 留给重 UI 按需升级

### 方案 方案B：全部插件的 UI 逻辑用 WASM 渲染（Canvas/Skia）
- 优点：绝对安全，无冻结
- 缺点：需引入 wasm-bindgen 等重工具链，插件开发门槛高
- 为何不选：拒绝。WASM UI 渲染生态不成熟，开发成本过高，偏离启动器插件场景

### 方案 方案C：维持内联渲染默认
- 优点：最简单
- 缺点：无隔离，被否决
- 为何不选：拒绝。冻结炸弹不可接受

## 影响
- plugin-ui 包：组件必须只消费 CSS 变量，禁止内联色值（已有大体满足，需审计）
- sandbox.ts：renderInline 改为 createSandbox 作为默认路径
- manifest schema：schemaVersion 升 2，新增 protocolVersion
- theme 系统：新增 theme manager + .qtheme 解析器 + icon/font 贡献注册
- launcher 侧：新增插件更新轮询 + 签名验证 + 安装 DAG 维护
- CLI 工程：新建 repo 或纳入 monorepo 的 packages/qomicex-cli
- store 侧：新增 developer_keys 表 + 签名上传接口 + 灰度字段 + 不可撤下约束
- 文档：30+ 页生态提案 + ADR-049 入库
- 性能陷阱：10 项技术债清单（见提案文档）
- ai-compliance：AI 生成插件需遵循 manifest schema 和权限最小化原则，skill 包纳入规范

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-25 | v1.0 | 初版创建 | AI Agent |