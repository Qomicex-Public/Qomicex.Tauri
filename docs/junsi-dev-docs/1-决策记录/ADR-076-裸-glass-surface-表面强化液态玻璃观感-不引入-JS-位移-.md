# ADR-076：裸 glass-surface 表面强化液态玻璃观感（不引入 JS 位移）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-11 |
| 决策者 | AI Agent |

## 背景

液态玻璃的「真折射/位移」仅由 plugin-ui 的 <Card> 提供（内部渲染 quidlass LiquidGlass）。资源中心列表用 <Card>，效果完整；其他页面（账户/实例/下载中心/主页组件等）用裸 div.glass-surface，只命中 index.css 的 blur+渐变，观感差异明显。实机验证：/accounts 页 liquidGlassCount=0、glassSurfaceCount=4。ADR-043 已明确液态玻璃仅用于 Card（性能考量）。

## 决策

不改裸 div 的结构（不加 JS 位移），仅强化 index.css 的 `:root[data-material="liquid"] .glass-surface` 规则：提高 backdrop 的 saturate(165%)/contrast(1.06)/brightness(1.03)，新增左上径向高光层，内缘 rim light（inset 0 0 0 1px）+ 底部内阴影 + 加深投影，使无位移表面也接近液态玻璃质感。亮色覆盖同步加强。

## 备选方案

### 方案 裸 glass-surface div 全改用 plugin-ui <Card>/LiquidGlass
- 优点：与资源中心一致的真位移效果
- 缺点：账户列表/实例卡/下载卡结构差异大，改动面广；每元素一个 SVG 位移滤镜有 GPU/CPU 开销（ADR-043 已因此限定仅 Card）
- 为何不选：舍弃

### 方案 新增 GlassSurface 包装组件
- 优点：复用逻辑
- 缺点：仍为每个表面引入 JS 渲染与 SVG 滤镜，未解决性能顾虑
- 为何不选：舍弃

### 方案 仅强化 index.css 的 liquid .glass-surface 观感
- 优点：零 JS 开销、零结构改动，一处 CSS 全局生效
- 缺点：无真位移（但裸 div 本来就没有），观感接近度有限
- 为何不选：采纳

## 影响
- src/index.css

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-11 | v1.0 | 初版创建 | AI Agent |