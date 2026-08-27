# CHECKPOINT_BATCH_1 — FA→Lucide 迁移

日期: 2026-08-27
状态: ✅ 通过（tsc --noEmit 无错误）

## 文件
- src/pages/InstanceDetail.tsx (84 icons → lucide，TABS/FILTER_OPTIONS 改组件引用)
- src/pages/Settings.tsx (85 icons → lucide，CATEGORIES 改组件引用，品牌 faGithub/faJava 保留，Settings→SettingsIcon 别名)
- src/pages/Instances.tsx (59 icons → lucide，FILTER_OPTIONS 改组件引用)

## 特殊处理
- 数组字段 `icon: faX` → `icon: X` 组件引用，渲染处 `<o.icon className=.../>`
- 字符串字面量联合类型三元转 JSX 三元时窄化报错 → 分支内写死 animate-spin（MAPPING_TABLE ternary_narrowing 规则）
- Settings 组件名冲突 → Settings as SettingsIcon 别名
- 已验证全部 lucide 导出存在（99 个唯一图标）

## 验证
- pnpm exec tsc --noEmit ✅
