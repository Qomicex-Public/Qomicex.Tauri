# ADR-037：玻璃材质与滚动渐隐遮罩互斥：材质激活时禁用 scroll-fade-mask

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-22 |
| 决策者 | AI Agent |

## 背景

用户报告：组件材质设为毛玻璃/亚克力/Aero 时卡片无模糊效果，液态玻璃无折射，仅呈半透明圆角矩形，背景透过卡片清晰可见。

排查（Playwright 注入 Tauri mock 实测）：卡片 computed backdrop-filter 值正确（如 blur(20px) saturate(1.5)），但视觉完全无效。枚举祖先链 computed style 发现页面滚动容器带 mask-image（.scroll-fade-mask / .scroll-fade-mask-both，底部渐隐装饰，12+ 页面通过 PageShell className 或 useScrollFade 使用）。按 filter-effects-2 规范，带 mask 的祖先形成 backdrop root，后代 backdrop-filter 只能采样该子树内绘制的内容，采不到其后的 position:fixed 壁纸。实测移除 mask 后模糊立即显现，证实因果。液态玻璃（quidlass LiquidGlass，内部同样依赖 backdrop-filter + SVG feDisplacementMap 位移折射）受同一机制影响。

另核实：生产 CSP img-src 已含 data:/blob:，feImage 位移图不受阻；InstanceDetail 滚动容器的 translateZ(0) 是 transform，不构成 backdrop root，无需处理。

## 决策

在 src/index.css 非分层区域新增一条规则：玻璃材质激活时禁用滚动渐隐遮罩——

:root[data-material]:not([data-material="default"]) .scroll-fade-mask,
:root[data-material]:not([data-material="default"]) .scroll-fade-mask-both {
  -webkit-mask-image: none;
  mask-image: none;
}

default 材质下渐隐遮罩保持不变；四种玻璃材质下遮罩禁用、backdrop-filter 恢复对壁纸的采样。选择器限定 [data-material] 属性存在才生效，避免设置加载前的瞬态误伤。

已验证（浏览器 + Tauri mock 注入）：frosted/acrylic/aero 的卡片 backdrop-filter 计算值生效且视觉模糊可见；liquid 渲染出 quidlass LiquidGlass 容器（backdropFilter blur/contrast/brightness/saturate + filter:url(#..._filter) 位移滤镜均激活），背景呈现模糊+扭曲；default 下遮罩照常工作。pnpm run build 通过。

## 备选方案

### 方案 玻璃材质下禁用 scroll-fade-mask（CSS 覆盖）
- 优点：单条 CSS 规则修复全部 12 处使用；毛玻璃/亚克力/Aero/液态玻璃一并修复；default 材质保留渐隐；零 JS 改动
- 缺点：渐隐提示消失，滚动到底部无视觉暗示
- 为何不选：mask 与 backdrop-filter 在规范层面互斥，二者只能选其一；渐隐是次要装饰，玻璃模糊是用户主动选择的核心功能

### 方案 用背景色渐变 overlay 替代 mask
- 优点：两种效果兼得（近似）
- 缺点：渐隐变为实色渐变条，遮挡壁纸形成色带，视觉劣化更明显
- 为何不选：未说明

### 方案 逐页面移除 scroll-fade-mask class
- 优点：显式直观
- 缺点：改动分散、易漏；useScrollFade 动态添加的 class 需要额外状态分支
- 为何不选：未说明

## 影响
- 玻璃材质下页面滚动到底部不再有内容渐隐提示（可接受的权衡，玻璃效果为核心诉求）
- 修复对所有 12+ 使用 scroll-fade-mask 的页面统一生效，无需改动任何 TSX
- 后续若新增其他带 mask/filter 的祖先容器包裹玻璃组件，会复现同类失效，需注意 backdrop root 语义

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-22 | v1.0 | 初版创建 | AI Agent |