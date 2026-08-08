# Qomicex Launcher 设计规范

## 1. 设计哲学

Qomicex Launcher 的 UI 设计遵循 **玻璃态 + 暗色主题** 的桌面应用美学，核心原则：

- **暗色优先**：默认深色主题，降低视觉疲劳，符合游戏玩家习惯
- **玻璃态层次**：通过 `backdrop-blur` + 半透明背景创建视觉层级
- **内容聚焦**：侧边栏图标导航，最大化内容区域利用
- **状态可感知**：通过颜色、动画、徽章清晰传达系统状态
- **渐进式披露**：复杂功能通过对话框、标签页组织，避免信息过载

---

## 2. 技术栈

| 层级 | 技术选型 | 版本 |
|------|----------|------|
| 桌面壳 | Tauri v2 (Rust) | 跨平台原生窗口 |
| 前端框架 | React 19 | 函数组件 + Hooks |
| 语言 | TypeScript | 严格模式 (`strict: true`) |
| 构建工具 | Vite 7 | 开发热更新 + 生产构建 |
| 样式系统 | Tailwind CSS | 暗色模式 (`darkMode: "class"`) |
| 路由 | React Router v6 | 11 个主页面 |
| 图标 | FontAwesome 6 | 统一视觉语言 |
| 组件库 | `@qomicex/plugin-ui` | 基于 shadcn/ui 二次封装 |

---

## 3. 主题系统

### 3.1 CSS 变量体系

```css
/* 颜色系统 - HSL 格式，支持透明度 */
--background:            /* 背景色 */
--foreground:            /* 前景色 */
--primary:               /* 主色调 */
--primary-foreground:    /* 主色文字 */
--secondary:             /* 次要色 */
--accent:                /* 强调色 */
--muted:                 /* 弱化色 */
--muted-foreground:      /* 弱化文字 */
--destructive:           /* 危险操作色 */
--border:                /* 边框色 */
--radius:                /* 圆角半径，默认 8px */
```

### 3.2 主题切换

- 通过 `document.documentElement.classList.toggle('dark', ...)` 切换
- 持久化到 `localStorage`（键名：`qomicex-theme`）
- Tauri 环境同步调用 `getCurrentWindow().setTheme()`

### 3.3 动态样式

```css
/* 动画控制 */
--anim-duration-multiplier: /* 动画速度倍率 */
[data-anim-enabled="false"]  /* 全局动画开关 */

/* 背景图片 */
background-image + backdrop-blur + 遮罩层
```

---

## 4. 布局架构

### 4.1 全局结构

```
Layout
├── 背景层 (可选)
│   ├── <img> 背景图片 (blur 过滤)
│   └── <div> 遮罩层 (hsl(var(--background)/opacity))
├── 主容器 (relative z-10)
│   ├── 侧边栏 Sidebar (w-16)
│   └── 内容区
│       ├── 标题栏 TitleBar (Windows 专属)
│       └── 页面内容 (Outlet)
└── 全局覆盖层
    ├── ScrollToTop
├── DebugEffects (F8 解锁)
├── PluginEventBridge
├── PluginOverlayManager
├── SplashScreen
├── LaunchProgressDialog
├── CrashAnalysisDialog
└── UpdateDialog
```

### 4.2 侧边栏规范

- **宽度**：64px (`w-16`)，图标居中
- **背景**：`bg-card/80 backdrop-blur-xl shadow-xl`
- **导航项**：11px 左侧高亮条 + 11x11 图标容器
  - 激活态：`bg-primary/10 text-primary`
  - 悬停态：`hover:bg-accent hover:text-foreground`
- **底部**：运行中（带脉冲绿点）+ 设置入口
- **插件槽位**：`PluginSidebarItems` 动态注入

### 4.3 页面容器

- **PageShell**：统一页面容器，`p-8` 内边距，`space-y-6` 垂直间距
- **PageHeader**：页面标题 + 副标题 + 操作区（右侧按钮组）
- **滚动**：`overflow-y-auto scroll-fade-mask`（渐隐遮罩）

---

## 5. 组件库规范

### 5.1 基础组件

所有组件统一从 `@qomicex/plugin-ui` 导出，遵循 **Radix UI** 无障碍标准：

| 组件 | 关键 Props | 使用场景 |
|------|-----------|----------|
| `Button` | `variant`, `size`, `disabled` | 主要操作入口 |
| `Card` | `className` | 内容分组容器 |
| `Input` | `value`, `onChange`, `readOnly` | 文本输入 |
| `Select` | `value`, `onChange`, `placeholder` | 下拉选择 |
| `Dialog` | `open`, `onClose`, `closeOnBackdrop` | 模态对话框 |
| `Tooltip` | `content`, `side` | 图标按钮提示（强制使用） |
| `Tabs` | `tabs`, `activeTab`, `onChange` | 标签切换 |
| `Checkbox` | `checked`, `onCheckedChange` | 多选开关 |
| `Combobox` | `value`, `onChange`, `options` | 可搜索下拉 |
| `Badge` | `variant`, `className` | 状态标签 |
| `Separator` | `className` | 内容分割 |
| `Table` | - | 数据表格 |
| `Textarea` | - | 多行文本 |
| `BatchToolbar` | `selectedCount`, `onClear` | 批量操作栏 |

### 5.2 组合组件

| 组件 | 用途 |
|------|------|
| `PageShell` | 页面容器，统一 padding 和滚动 |
| `PageHeader` | 页面标题栏，带 subtitle 和 actions |
| `AccountAvatar` | 账户头像（支持皮肤渲染） |
| `InstanceIcon` | 实例图标（支持自定义 iconData） |
| `PluginIcon` | 插件图标 |
| `ContextMenu` | 右键菜单 |
| `SplashScreen` | 启动等待画面 |

---

## 6. 路由结构

```
/                          首页 (Dashboard)
/instances                 实例列表
/instances/:id             实例详情
/downloads                 下载中心
/accounts                  账户管理
/accounts/:uuid            账户详情
/resource-center           资源中心
/resource-center/:resourceId  资源详情
/connect                   联机
/settings                  设置
/running                   运行中游戏
/plugins/p/:pluginId       插件页面 (未在 Layout 路由中注册)
```

### 6.1 路由约定

- **内部导航**：使用 `<Link>`（避免页面刷新丢失状态）
- **外部链接**：使用 `<a target="_blank" rel="noopener noreferrer">`
- **拦截外部链接**：`Layout` 层统一监听点击，弹出确认框
- **页面切换动画**：`usePageAnimation` hook 控制

---

## 7. 页面设计详解

### 7.1 首页 (`/`)

**布局**：绝对定位 + flex 居中

```
┌─────────────────────────────────────────────┐
│  [Sidebar]  │                    │ [Account] │
│             │                    │ [公告卡片] │
│             │    品牌水印         │           │
│             │    Qomicex          │           │
│             │    启动器           │           │
│             │                    │           │
│             │ [──────── 底部操作栏 ────────] │
│             │ [实例图标] [名称] [状态] [启动] │
└─────────────────────────────────────────────┘
```

**状态**：
- 默认实例存在 → 显示底部操作栏
- 无默认实例 → 虚线框引导前往实例管理

### 7.2 实例列表 (`/instances`)

**三步骤状态机**：

```
list → select-version → configure → (下载完成)
```

**核心交互**：
- 目录选择器（下拉 + 管理弹窗）
- 版本网格/列表双视图
- 筛选标签（全部/模组/原版/快照/愚人节/错误）
- 扫描本地版本（自动创建缺失实例）

### 7.3 实例详情 (`/instances/:id`)

**10 标签页**：

| 标签 | 图标 | 内容 |
|------|------|------|
| 概况 | faInfoCircle | 基本信息、Java 路径、启动按钮 |
| 设置 | faSliders | 内存、Java、窗口大小 |
| 游戏设置 | faGamepad | Quick Play、服务器 |
| 存档 | faSave | 列表、搜索、批量删除、快速加入 |
| 截图 | faCamera | 图片网格 |
| Mod | faCube | 启用/禁用/删除、批量操作 |
| 资源包 | faBox | 启用/禁用/删除 |
| 光影包 | faSun | 启用/禁用/删除 |
| 数据包 | faDatabase | 启用/禁用/删除 |
| 服务器 | faServer | 添加、ping、快速加入 |

**批量操作模式**：
- Shift 多选 / Ctrl 切换
- 底部 `BatchToolbar` 浮出
- 右键 `ContextMenu` 上下文菜单

### 7.4 下载中心 (`/downloads`)

**任务状态机**：

```
queued → downloading → paused → completed
                              → failed → (重试)
                              → cancelled
```

**SSE 实时同步**：
- 连接断开时自动轮询兜底
- "僵尸任务"检测（后端重启后过期任务自动标记失败）

### 7.5 账户管理 (`/accounts`)

**四种登录方式**：

```
┌─────────────────────────────────┐
│  [Microsoft] [离线] [Yggdrasil] [统一通] │
├─────────────────────────────────┤
│  账户列表 (带搜索和筛选)         │
│  □ 头像  名称    方式    [☆] [🗑] │
│  ☑ 头像  名称    方式    [☆] [🗑] │
└─────────────────────────────────┘
```

**Yggdrasil 两步流程**：表单 → 角色选择（多选）

### 7.6 资源中心 (`/resource-center`)

**搜索参数快照**（页面状态保持）：

```typescript
interface Snapshot {
  category: string
  source: string
  keyword: string
  sort: string
  gameVersion: string
  loader: string
  items: ResourceItem[]
  total: number
  page: number
  scrollY: number
}
```

**缓存策略**：
- 内存缓存：`Map<string, Map<page, PageCache>>`，TTL 5 分钟
- 组件卸载时保存快照，重新挂载时恢复

### 7.7 联机 (`/connect`)

**流程**：

```
idle
├── 创建房间
│   ├── 选择实例启动 → starting → host (房间码 + 玩家列表)
│   └── 手动输入/扫描端口 → host
└── 加入房间 → guest (服务器地址 + 玩家列表)
```

**EasyTier 自动下载**：状态轮询（resolving → downloading → extracting → installed）

### 7.8 设置 (`/settings`)

**8 个分类标签页**：

```typescript
const CATEGORIES = [
  { id: 'launcher', label: '启动器', icon: faRocket },
  { id: 'java', label: 'Java 运行时', icon: faCoffee },
  { id: 'plugins', label: '插件', icon: faPuzzlePiece },
  { id: 'appearance', label: '外观', icon: faPalette },
  { id: 'toolbox', label: '工具箱', icon: faDownload },
  { id: 'logs', label: '日志', icon: faFileLines },
  { id: 'about', label: '关于', icon: faInfoCircle },
  { id: 'debug', label: '调试', icon: faBug }, // F8 解锁
]
```

---

## 8. 状态管理

### 8.1 全局设置

- **存储**：`localStorage` + 后端 API 同步
- **订阅**：`onSettingsChange` 回调，实时更新 UI
- **范围**：下载源、动画、背景、Java 路径、内存等

### 8.2 运行中实例 (`RunningContext`)

```typescript
interface RunningInstance {
  instanceId: string
  name: string
  startedAt: number
  processId?: number
}
```

- 提供 `launchInstance`, `killInstance`, `notify`
- 全局共享运行状态

### 8.3 下载任务 (`downloadStore`)

```typescript
interface DownloadTask {
  id: string
  type: 'game' | 'java' | 'resource' | 'repair' | 'batch' | 'file'
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'
  progress: number
  speed?: number
  stage?: string
  // ... 其他字段
}
```

- 订阅发布模式：`subscribe`, `addTask`, `updateTask`, `removeTask`
- SSE 实时推送 + 轮询兜底

### 8.4 Java 运行时 (`javaStore`)

```typescript
interface JavaRuntime {
  name: string
  version: string
  arch: string
  path: string
  type: string
  state: 'Valid' | 'Invalid'
  discoveredBy: 'Scan' | 'Custom'
}
```

- 扫描：`scanRuntimes('quick' | 'deep')`
- 自定义：`addCustomJavaRuntime`, `removeCustomJavaRuntime`
- 订阅：`subscribe(() => setRuntimesState([...getRuntimes()]))`

### 8.5 插件状态 (`pluginStore`)

```typescript
interface PluginState {
  id: string
  name: string
  state: 'installed' | 'active' | 'disabled'
  manifest: PluginManifest
  // ...
}
```

- 加载：`loadPlugins()`
- 激活：`activatePlugin(plugin)`（拓扑排序依赖）
- Overlay：`createOverlay`, `showOverlay`, `hideOverlay`, `destroyOverlay`

---

## 9. 交互设计规范

### 9.1 消息框 (`MessageBox`)

```typescript
const { alert, confirm, prompt, notify } = useMessageBox()
```

- 替代原生 `alert/confirm/prompt`
- 统一暗色风格
- `notify` 用于成功/错误提示（自动消失）

### 9.2 加载状态

- **旋转图标**：`faRotate` + `animate-spin`
- **骨架屏**：`animate-pulse` + 灰色块
- **脉冲点**：`animate-ping`（运行中指示）

### 9.3 错误处理

- **ApiError**：统一错误类型，`code`, `status`, `detail`, `traceId`
- **显示**：通过 `MessageBox` 展示 `displayMessage`
- **崩溃分析**：集成 mclo.gs，二维码分享

### 9.4 确认对话框

- 危险操作（删除、取消）使用 `msgConfirm`
- 按钮布局：取消（左）+ 确认（右，危险色）

### 9.5 外部链接

```typescript
// Layout 层统一拦截
document.addEventListener('click', (e) => {
  const a = e.target.closest('a')
  if (a?.href && url.origin !== window.location.origin) {
    e.preventDefault()
    msgConfirm(`即将打开外部链接：\n${url.href}`).then(ok => {
      if (ok) openUrl(url.href)
    })
  }
})
```

---

## 10. 响应式设计

### 10.1 断点策略

- **移动端优先**：核心功能在小屏幕可用
- **断点**：`sm:` `md:` `lg:` `xl:`（Tailwind 默认）

### 10.2 适配规则

| 元素 | 适配 |
|------|------|
| 标题栏 | Linux/macOS 隐藏（系统原生） |
| 侧边栏 | 固定 64px，图标自适应 |
| 卡片网格 | `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` |
| 按钮文字 | 小屏幕隐藏文字，仅显示图标 |

### 10.3 跨平台考虑

- **路径分隔符**：`.replace(/\\/g, '/')`
- **文件选择器**：Windows 过滤 `.exe`，其他平台 `*`
- **URI 格式**：Unix `file:///`，Windows `file://`

---

## 11. 插件系统 UI

### 11.1 渲染模式

- **Inline（l1/l2）**：注入到 `PluginPage` 容器
- **Sandbox（l2）**：iframe + postMessage 桥接
- **WASM（l3）**：Tauri WASM 网关渲染

### 11.2 侧边栏注入

```typescript
// PluginSidebarItems
links.push({
  to: `/plugins/p/${plugin.id}`,
  label: plugin.manifest.name,
  icon: <PluginIcon plugin={plugin} />
})
```

### 11.3 Overlay 系统

```typescript
// PluginOverlayManager
const overlay = createOverlay(pluginId, { x, y, width, height })
// iframe sandbox="allow-scripts"
// 全局暴露 window.__pluginOverlayStore
```

---

## 12. 无障碍规范

- **Tooltip 强制**：所有图标按钮必须包裹 `<Tooltip>`
- **ARIA 属性**：`role`, `aria-checked`, `aria-label`
- **键盘导航**：支持 `Enter`/`Space` 触发，`Escape` 关闭
- **焦点管理**：Dialog 打开时聚焦，关闭时恢复
- **语义化 HTML**：`<nav>`, `<main>`, `<header>`

---

## 13. 性能规范

### 13.1 渲染优化

- **React.memo**：列表项（`ResourceCard`, `ModCard` 等）
- **useMemo**：筛选、排序、派生数据
- **useCallback**：事件处理函数
- **懒加载**：图片 `loading="lazy"`

### 13.2 缓存策略

- **内存缓存**：`simple-cache.ts`（TTL 支持）
- **页面快照**：`savedSnapshot`（滚动位置、筛选条件）
- **头像缓存**：`invalidateAvatarCache()` 手动失效

### 13.3 SSE 实时通信

```typescript
// useDownloadSSE
const { data, reconnectKey } = useDownloadSSE()
// 断开重连后自动轮询验证任务状态
```

---

## 14. 设计令牌

### 14.1 颜色语义

| 令牌 | 用途 | 示例 |
|------|------|------|
| `primary` | 主操作、激活态 | 启动按钮、选中项 |
| `destructive` | 危险操作 | 删除、取消、关闭 |
| `muted` | 弱化内容 | 时间戳、辅助信息 |
| `accent` | 悬停背景 | hover 状态 |
| `border` | 边框、分割 | 卡片边框、输入框 |

### 14.2 圆角系统

- 默认：`8px`（可配置）
- 小：`rounded-md` (6px)
- 中：`rounded-lg` (8px)
- 大：`rounded-xl` (12px)
- 圆：`rounded-full` (圆形)

### 14.3 间距系统

- 页面内边距：`p-8` (32px)
- 卡片间距：`space-y-4` (16px)
- 组件间距：`gap-2` `gap-3` `gap-4`

### 14.4 字体系统

- **默认**：系统无衬线字体
- **代码**：`font-mono`（Java 路径、版本号）
- **水印**：`tracking-widest`（品牌展示）
- **徽章**：`text-[10px]`（小标签）

---

## 15. 动画规范

### 15.1 全局控制

```typescript
// Settings 中控制
animationsEnabled: boolean  // 全局开关
animationSpeed: number      // 倍率 (0.5 - 2)
maxFrameRate: number        // 最大 FPS (0 = 无限制)
```

### 15.2 常用动画

- **页面进入**：`animate-in fade-in slide-up`
- **按钮反馈**：`active:scale-95`
- **加载旋转**：`animate-spin`
- **脉冲提示**：`animate-ping`（运行中绿点）
- **列表动画**：`anim-stagger`（逐项延迟）

---

## 16. 安全规范

- **密钥存储**：Bing API Key 使用 `type="password"` 输入框
- **外部链接确认**：所有外部链接弹窗确认
- **文件操作授权**：插件文件读写需用户确认（`FS_AUTHORIZATION_REQUIRED`）
- **错误脱敏**：后端错误不暴露堆栈（除非调试模式）

---

## 17. 调试模式

**解锁方式**：连按 F8 8 次（2 秒内）

**功能**：
- 组件边界高亮（红色轮廓）
- FPS 计数器
- 日志覆盖层
- 调试标签页（设置中可见）

---

## 18. 文件规范

### 18.1 导入规则

```typescript
// ✅ 正确：包含文件扩展名
import { foo } from './bar.ts'
import { x } from '../components/ui/index.ts'

// ❌ 错误：Vite 路径 bug
import { x } from '../components/ui'
```

### 18.2 组件命名

- 页面组件：`PascalCase`（`Dashboard.tsx`）
- 子组件：`PascalCase`（`AccountAvatar.tsx`）
- Hooks：`camelCase` + `use` 前缀（`useRunning`）

### 18.3 样式类顺序

```tsx
className={cn(
  'base-class',           // 基础样式
  condition && 'active',  // 条件类
  'hover:bg-accent'       // 交互态
)}
```

---

## 19. 设计资源

- **Logo**：`/logo.svg`（64x64，圆角 8px）
- **图标库**：FontAwesome 6（Solid + Brands）
- **图片占位**：`bg-muted text-muted-foreground` + 图标

---

## 20. 未来规划

- [ ] 响应式移动端适配（平板横屏）
- [ ] 插件主题系统（CSS 变量覆盖）
- [ ] 更多背景动画效果（粒子、渐变）
- [ ] 国际化支持（i18n）
- [ ] 无障碍增强（屏幕阅读器优化）
