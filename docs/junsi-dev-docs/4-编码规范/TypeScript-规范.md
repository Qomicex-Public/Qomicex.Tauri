# TypeScript 编码规范

从项目 `AGENTS.md` 和 `tsconfig.json` 提取的约定。

## 基本规则

- 启用严格模式 (`strict: true`)
- 启用 `noUnusedLocals` 和 `noUnusedParameters` — 未使用的变量/参数导致构建失败
- 所有本地 TS/TSX 导入**必须包含文件扩展名**: `import { foo } from './bar.ts'`
- 禁止使用不带扩展名的导入: `import { x } from './baz'` (Vite path bug)

## 命名约定

- 组件: PascalCase (`InstanceDetail`)
- 文件: camelCase? (项目中混合使用, 参考 `api/account.ts`, `App.tsx`)
- 类型/接口: PascalCase (参考 `types/index.ts`)
- 常量: UPPER_SNAKE_CASE 或 PascalCase 或 camelCase (参考 `constants/credits.ts`)

## 导入规范

```ts
import { cn } from '../lib/utils.ts'
import { Button } from '../components/ui/button.tsx'
```

- Radix UI 优先于原生 HTML 元素 (例如 `Select` 代替 `<select>`)
- 使用 `cn()` 进行 Tailwind 类合并 (`src/lib/utils.ts`)
- 工具提示使用 `Tooltip` 组件，不要使用原生 `title` 属性

## 样式

- 使用 Tailwind CSS 类 (`className`)
- 使用 `cn()` 合并类
- 暗色模式通过 `dark:` 前缀实现，基于 `darkMode: "class"` 策略

## 错误处理

```ts
import { ApiError } from '../api/client.ts'
try { ... } catch (e) { if (e instanceof ApiError) showToast(e.displayMessage) }
```

## 导航

- 内部导航使用 `<Link>` 组件，不要使用 `<a>` 标签 (否则会导致页面刷新，重置持久状态)
- 外部链接使用 `<a target="_blank">`

## 路径规范化

- 后端路径需要正斜杠: `.replace(/\\/g, '/')`
- 文件选择器过滤器: Windows 上为 `['exe']`，其他平台为 `['*']`
- Unix 上的 `file://` URI: `'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '')`
