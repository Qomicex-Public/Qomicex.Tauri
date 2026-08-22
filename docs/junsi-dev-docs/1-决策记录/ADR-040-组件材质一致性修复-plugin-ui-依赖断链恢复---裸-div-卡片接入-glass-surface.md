# ADR-040：组件材质一致性修复：plugin-ui 依赖断链恢复 + 裸 div 卡片接入 glass-surface

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-22 |
| 决策者 | AI Agent |

## 背景

用户报告设置组件材质（frosted/acrylic/aero/liquid，App.tsx 经 documentElement.dataset.material 下发，index.css 以非分层 :root[data-material] .glass-surface 规则接管背景/backdrop-filter/border）后，下载管理、账户管理、实例管理、实例详情资源列表卡、主页账户选择器、公告卡片等大量卡片不跟随。排查发现两层根因：①（决定性）根 package.json 依赖 @qomicex/plugin-ui 声明为 ^0.1.0，而本地包已演进到 0.2.1——^0.1.0 按 caret 语义不含 0.2.x，b7c7822 设计的 link-workspace-packages=true 本地软链因版本不匹配静默失效，pnpm 回退安装 registry 上的 0.1.0，该版本的 Card 完全没有 useMaterial/quidlass/glass-surface 材质集成（grep 计数 0），导致所有基于 Card 的表面（ModCard/SaveCard/ResourcePackCard/ShaderCard/DataPackCard/ResourceCenter/联机中心等）全部不跟随；②部分页面用裸 div 自绘卡片（只有 bg-card 无 glass-surface 类），CSS 规则无从命中。Playwright 注入 Tauri mock 实测证实：用户后端保存的正是 frosted+glassBlur=7px，修复前上述卡片呈不透明 bg-card。

## 决策

双管齐下：① 根依赖升级为 ^0.2.1（匹配已发布的含材质集成版本），恢复 link-workspace-packages 本地 Junction 软链——本地开发直接使用工作区源码（含今日 cbf478a 的 liquid 布局修复），CI/其他机器经 lockfile 拿到 registry 0.2.1，保持 b7c7822「registry 依赖+本地软链」策略不变；② 为 11 处裸 div 卡片表面补 glass-surface 类（Dashboard 账户选择器/底部启动栏/空实例占位、AnnouncementCard、Accounts 列表行、AccountDetail 两卡、DownloadCenter 任务卡、Instances 网格+列表实例卡、InstanceDetail 投影文件选择卡、ScreenshotCard）。default 材质下无对应 CSS 规则，保持原样（含 backdrop-blur-md 等 utilities）；frosted/acrylic/aero/liquid 由非分层规则优先覆盖 Tailwind utilities 接管。

## 备选方案

### 方案 改回 workspace:*
- 优点：永远使用最新源码，无需关心发包
- 缺点：与 b7c7822 的发布策略冲突，且 lockfile 协议变化影响面大
- 为何不选：b7c7822 已确立 registry 依赖策略，尊重既有决策做最小修正

### 方案 仅补 glass-surface 类，不动依赖
- 优点：改动最小
- 缺点：治标不治本，Card 系组件（模组/存档/资源包/光影/数据包/资源中心）依然不跟随
- 为何不选：裸 div 补类只解决一半问题，材质集成的主体在 Card 组件里

### 方案 发布 plugin-ui 0.2.2 后再升级依赖
- 优点：registry 用户也拿到今天 cbf478a 的 Card liquid 布局修复
- 缺点：需要 npm 凭据与发布流程介入，阻塞本任务
- 为何不选：本地开发经软链已拿到全部源码；0.2.2 发布可后续由维护者执行

## 影响
- package.json / pnpm-lock.yaml（依赖 ^0.1.0→^0.2.1）
- src/pages/Dashboard.tsx
- src/components/AnnouncementCard.tsx
- src/pages/Accounts.tsx
- src/pages/AccountDetail.tsx
- src/pages/DownloadCenter.tsx
- src/pages/Instances.tsx
- src/pages/InstanceDetail.tsx
- src/components/ScreenshotCard.tsx
- 后续给 plugin-ui 发新版本时必须同步提升根依赖版本范围（否则软链再次静默断开）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-22 | v1.0 | 初版创建 | AI Agent |