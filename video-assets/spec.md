# Qomicex Launcher 宣传片 — 设计 Spec 草案（阶段 0）

## 1. 需求决策表

| 决策项 | 结论 | 理由 |
|--------|------|------|
| 制作模式 | 自主自由创作 | 用户确认 |
| 目标时长 | ~36s（SFX-only，可扩展） | 匹配 skill 已验证模板节奏 |
| 输出规格 | 1920×1080 @30fps，H.264 MP4（可加 WebM 备选） | 通用分发 |
| 画面风格 | 深色玻璃拟态 + 绿色 accent，与产品 UI 一致 | 品牌一致性 |
| 音乐 | SFX-only（UI 微交互音效）；VO 可选 | 规避版权音乐风险 |
| 语言 | 中文（字幕/字卡）；品牌名 QOMICEX 保持英文 | 产品中文 UI |
| 数据红线 | 全部使用虚构演示数据，无真实/个人数据 | skill 红线 |

## 2. 风格 Tokens

- **背景**：`hsl(230 20% 6%)`（产品 `--background`），带细微噪点/网格渐变
- **主色**：`hsl(142 71% 48%)`（产品 primary，绿）
- **强调色**：`hsl(220 14% 96%)`（前景文字）、`hsl(0 0% 100% / 8%)`（卡片描边）
- **玻璃拟态**：卡片 `bg-card/70` + `border-border/30` + 大圆角
- **排版**：主字卡用重字重（700/800），副文本用 400；英文品牌名用等宽/几何无衬线（与 logo 呼应）
- **动效语言**：2.5D 平移/缩放、卡顿切（节奏卡点）、进度条/下载动画、玻璃反射扫过

## 3. 功能清单（出镜）

1. 品牌启动画面 + 首页水印品牌（Qomicex / Launcher）
2. 多实例管理（6 版本卡：Forge/Fabric/NeoForge/Vanilla/Quilt/OptiFine）
3. 极速下载（多任务并行、进度条、断点续传、下载中心）
4. 资源中心（Modrinth/CurseForge 真实数据、模组/光影/整合包/材质）
5. 账户管理（离线账户、皮肤）
6. 联机（创建/加入房间，EasyTier 点对点，无公网 IP）
7. 设置深度定制（版本隔离、下载源、Java 运行时、外观/插件）

## 4. 镜头映射方向（段 → 素材 → 运镜）

| 段 | 素材 | 运镜 |
|----|------|------|
| S1 | `logo` 字卡 | 静态缩放 + 玻璃扫过，品牌出现 |
| S2 | `dashboard-full` | 缓慢推近至启动按钮 |
| S3 | `instances-full` / `inst-card1-6` | 网格横向滑入，卡顿切换 6 卡 |
| S4 | `downloads-full` / `dl-task*` | 进度条增长动画，节奏卡点 |
| S5 | `resource-center-full` / `rc-card*` | 卡片轮播，2.5D 纵深 |
| S6 | `connect-full` / `conn-card*` | 聚焦"创建/加入房间"按钮 |
| S7 | `settings-full` / `set-panel*` | 面板推移，设置项高亮 |
| S8 | `logo` + slogan | 品牌收束 + slogan 字卡 |

## 5. 已验证素材清单

- 全页 2x 截图（1920×1080@2x）：`video-assets/textures/live/*-full.png` ×8
- 元素 cutout（透明底）：`inst-card1-6`、`dl-task1-5`、`rc-card1-4`、`acc-card1-3`、`dash-*`、`acd-*`、`conn-*`、`set-*`
- 布局坐标：`video-assets/layout.json`
- 文案：`video-assets/copy.md`
- 采集脚本（可复现）：`video-assets/scripts/capture-qml.mjs`

## 6. 风险与待决

- [ ] 品牌字卡（logo 元素）需从 `/logo.svg` 渲染，或在 Remotion 中以 SVG/PNG 方式生成
- [ ] 进度条/下载动画需在 Remotion 中复刻（不能直接用静态截图）
- [ ] 资源中心截图含外部图标 URL，离线渲染时需本地化
- [ ] 是否加 VO（中文旁白脚本已备，见 copy.md）
