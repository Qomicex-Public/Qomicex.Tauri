# ADR-074：Switch 开关圆点位置对称修正

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-11 |
| 决策者 | AI Agent |

## 背景

plugin-ui 的 Switch 由 shadcn 模板移植。Root 宽 w-9=36px，Thumb 16px，checked 位移 translate-x-4=16px。原实现误把 border-2 写成 border（1px），导致 1+16+16+1=34≠36：关闭态左边距 1px、开启态右边距 3px，圆点整体偏左。

## 决策

把 Switch.tsx 根节点边框恢复为 shadcn 原版的 `border-2 border-transparent`，使 2+16+16+2=36 左右对称。改动仅 1 个 class，需重建 plugin-ui dist。

## 备选方案

### 方案 调整 thumb 尺寸或位移
- 优点：不动边框
- 缺点：偏离 shadcn 标准，且 thumb 16px 已是 h-4，无 2px 可减
- 为何不选：舍弃

### 方案 加 padding 补偿
- 优点：不动 border
- 缺点：引入不必要复杂度，border 透明改宽度即可
- 为何不选：舍弃

### 方案 恢复 border-2（与 shadcn 一致）
- 优点：几何恰好对称，改动最小，与上游模板一致
- 缺点：无
- 为何不选：采纳

## 影响
- packages/plugin-ui/src/components/Switch.tsx

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-11 | v1.0 | 初版创建 | AI Agent |