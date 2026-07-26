# UI / 组件设计

## 概述

UI 设计基于 CSS 自定义属性 + Tailwind CSS 的暗色/亮色双主题方案。

## 文档

| 文档 | 路径 | 说明 |
|:---|:---|:---|
| UI 设计系统 | [UI设计系统.md](UI设计系统.md) | 设计令牌、颜色系统、排版、间距、动画、交互状态 |

## 组件规范

现有 UI 基元组件位于 `src/components/ui/`:

| 组件 | 基于 | 用途 |
|:---|:---|:---|
| Badge | - | 徽标/标签 |
| BatchToolbar | - | 批量操作工具栏 |
| Button | Radix Slot | 按钮 (变体: primary/secondary/danger/ghost) |
| Card | - | 卡片容器 |
| Checkbox | Radix Checkbox | 复选框 |
| Combobox | - | 组合框 |
| Dialog | Radix Dialog | 模态弹窗 |
| Input | - | 文本输入框 |
| Label | Radix Label | 标签 |
| MessageBox | - | 消息提示框 |
| Select | - | 选择器 |
| Separator | Radix Separator | 分割线 |
| Table | - | 表格 |
| Tabs | Radix Tabs | 选项卡 |
| Textarea | - | 多行文本输入 |
| Tooltip | - | 工具提示 |

## 样式系统

- CSS 变量在 `src/index.css` 中定义
- 暗色模式通过 `class="dark"` 切换
- Tailwind 配置: `darkMode: "class"`
- 类合并: `cn()` 工具函数 (基于 `tailwind-merge` + `clsx`)
