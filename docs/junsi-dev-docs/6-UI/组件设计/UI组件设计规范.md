# UI 组件设计规范

基于 `src/components/ui/` 的 16 个基元组件。使用 Radix UI、class-variance-authority (cva)、Tailwind CSS。

## 通用约定

| 约定 | 规则 |
|:---|:---|
| className 合并 | `cn()` 工具函数 (`tailwind-merge` + `clsx`)，自定义 className 置于末尾 |
| 暗色模式 | CSS 变量在 `:root` / `.dark` 中定义，Tailwind `darkMode: "class"` |
| 毛玻璃弹窗 | 统一 `bg-popover/90 backdrop-blur-lg border-border/50` |
| 动画 | `transition-all duration-150`，按钮 `active:scale-95` |
| 聚焦样式 | `focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring` |
| 禁用 | `opacity-50 cursor-not-allowed pointer-events-none` |
| 导入扩展名 | 始终包含 `.ts` / `.tsx` |

---

## Button

| 属性 | 说明 |
|:---|:---|
| Props | `variant`, `size`, `asChild` (Radix Slot), 标准 button 属性 |
| variant | `default` (绿) / `destructive` (红) / `outline` / `secondary` / `ghost` / `link` |
| size | `default` (h-9 px-4) / `sm` (h-8 px-3 text-xs) / `lg` (h-10 px-8) / `icon` (h-9 w-9) |

```tsx
<Button>提交</Button>
<Button variant="destructive" size="sm">删除</Button>
<Button variant="outline" size="icon"><Icon /></Button>
<Button asChild><a href="/link">链接</a></Button>
```

## Badge

| 属性 | 说明 |
|:---|:---|
| variant | `default` (绿) / `secondary` (灰) / `destructive` (红) / `outline` |

```tsx
<Badge>标签</Badge>
<Badge variant="destructive">错误</Badge>
```

## Card

| 子组件 | 说明 |
|:---|:---|
| `Card` | `rounded-xl border bg-card text-card-foreground shadow` |
| `CardHeader` | `flex flex-col space-y-1.5 p-6` |
| `CardTitle` | `font-semibold leading-none tracking-tight` |
| `CardDescription` | `text-sm text-muted-foreground` |
| `CardContent` | `p-6 pt-0` |
| `CardFooter` | `flex items-center p-6 pt-0` |

```tsx
<Card>
  <CardHeader><CardTitle>标题</CardTitle><CardDescription>描述</CardDescription></CardHeader>
  <CardContent>内容</CardContent>
  <CardFooter>操作</CardFooter>
</Card>
```

## Dialog

| 属性 | 说明 |
|:---|:---|
| Props | `open`, `onClose`, `closeOnBackdrop` (默认 true), `closeOnEsc` (默认 true) |
| 子组件 | `DialogHeader` (含可选关闭按钮)、`DialogTitle`、`DialogDescription`、`DialogBody`、`DialogFooter` |
| 弹窗 | `createPortal` → body，黑色遮罩 `backdrop-blur-sm`，`bg-popover/90 backdrop-blur-lg max-w-lg` |

```tsx
<Dialog open={open} onClose={() => setOpen(false)}>
  <DialogHeader onClose={() => setOpen(false)}><DialogTitle>标题</DialogTitle></DialogHeader>
  <DialogBody>内容</DialogBody>
  <DialogFooter><Button onClick={() => setOpen(false)}>确定</Button></DialogFooter>
</Dialog>
```

## Select

| 组件 | 说明 |
|:---|:---|
| `Select` | `value`, `onChange`, `placeholder`, `disabled` |
| `SelectOption` | `value`, `disabled` |
| `SelectDivider` | 分隔线 |

- 自动搜索：选项 > 6 个时显示 `faMagnifyingGlass` 搜索框
- 选中项高亮 `bg-primary/10 text-primary font-medium`
- 空搜索显示"无匹配"
- 毛玻璃弹出层 + zoom-in-95 动画

```tsx
<Select value={val} onChange={setVal}>
  <SelectOption value="a">选项A</SelectOption>
  <SelectDivider />
  <SelectOption value="b">选项B</SelectOption>
</Select>
```

## Tooltip

| 属性 | 说明 |
|:---|:---|
| `content` | ReactNode |
| `side` | `top` / `bottom` / `left` / `right` (默认 top) |
| `delay` | ms (默认 300) |

- `createPortal` → body，`pointer-events-none`，`bg-popover/90 backdrop-blur-lg`
- 通过 `getBoundingClientRect()` 定位

```tsx
<Tooltip content="删除" side="bottom">
  <Button variant="ghost" size="icon"><TrashIcon /></Button>
</Tooltip>
```

## Input / Textarea

标准 HTML 元素属性。Input: `h-9 rounded-md border px-3 py-1 text-sm`。Textarea: `min-h-[60px] px-3 py-2 text-sm`。

```tsx
<Input placeholder="输入..." />
<Textarea rows={4} />
```

## Checkbox

基于 Radix `@radix-ui/react-checkbox`。16x16 圆角，选中时绿色填充白色对勾。

```tsx
<Checkbox checked={bool} onCheckedChange={setBool} />
```

## Label

`text-sm font-medium leading-none`，`peer-disabled:cursor-not-allowed peer-disabled:opacity-70`。

## Combobox

输入 + 过滤下拉。实时大小写不敏感过滤，焦点展开，外部点击关闭关闭并提交。

```tsx
<Combobox value={val} onChange={setVal}
  options={[{value:'a',label:'A'}]} placeholder="搜索..." />
```

## Table

8 个子组件：`Table`、`TableHeader`、`TableBody`、`TableFooter`、`TableHead`、`TableRow`、`TableCell`、`TableCaption`。

```tsx
<Table>
  <TableHeader><TableRow><TableHead>名称</TableHead></TableRow></TableHeader>
  <TableBody><TableRow><TableCell>数据</TableCell></TableRow></TableBody>
</Table>
```

## Tabs

| 属性 | 说明 |
|:---|:---|
| `tabs` | `Tab[]` (`id`, `label`, `icon?`, `disabled?`) |
| `activeTab` / `onChange` | 受控 |
| `orientation` | `horizontal` / `vertical` |

- 滑动指示器：绝对定位 `div bg-primary/10 rounded-lg`，实时更新位置
- TabContent：非活跃返回 null，切换时 slide-in-right 动画

```tsx
<Tabs tabs={[{id:'a',label:'标签A'}]} activeTab={tab} onChange={setTab} />
<TabContent activeTab={tab} tabId="a">内容</TabContent>
```

## BatchToolbar

| 属性 | 说明 |
|:---|:---|
| `selectedCount` | > 0 时显示 |
| `onClear` | 取消选择 |
| `onSelectAll?` | 全选 |

固定在底部中央 (`fixed bottom-8 left-1/2`)，滑入/滑出动画。

```tsx
<BatchToolbar selectedCount={n} onClear={clear} onSelectAll={selectAll}>
  <Button>批量操作</Button>
</BatchToolbar>
```

## MessageBox (Context Provider)

7 个方法通过 `useMessageBox()` 获取：

| 方法 | 返回 | 说明 |
|:---|:---|:---|
| `alert(msg, title?)` | `Promise<void>` | 信息提示 |
| `confirm(msg, title?)` | `Promise<boolean>` | 确认框 |
| `choose(msg, confirmText, cancelText, title?)` | `Promise<boolean>` | 自定义按钮 |
| `error(msg, title?)` | `Promise<void>` | 错误提示 |
| `success(msg, title?)` | `Promise<void>` | 成功提示 |
| `prompt(msg, title?, default?)` | `Promise<string\|null>` | 输入框 |
| `notify(msg, type?)` | `void` | 3s toast |

```tsx
const mb = useMessageBox()
await mb.confirm('确定删除？')
mb.notify('已保存', 'success')
```

## Separator

`h-[1px] w-full bg-border`。

## 颜色系统

所有颜色使用 HSL CSS 变量：

| Token | Dark (默认) | Light | 用途 |
|:---|:---|:---|:---|
| `--background` | `230 20% 6%` | `0 0% 100%` | 页面背景 |
| `--foreground` | `220 20% 93%` | `228 20% 10%` | 主文字 |
| `--primary` | `142 71% 48%` | `142 71% 42%` | 强调绿 (CTA) |
| `--card` | `228 18% 10%` | `0 0% 98%` | 卡片背景 |
| `--popover` | `228 18% 10%` | `0 0% 98%` | 弹窗背景 |
| `--destructive` | `0 84% 60%` | `0 84% 60%` | 危险红 |
| `--border` | `228 14% 21%` | `228 12% 88%` | 边框 |
| `--ring` | `142 71% 48%` | `142 71% 42%` | 聚焦环 |
| `--radius` | `0.625rem` | `0.625rem` | 圆角 |

## 动画

| 类名 | 效果 |
|:---|:---|
| `.fade-in` | opacity 0→1 |
| `.zoom-in-95` | scale(0.95) + opacity 0→1 |
| `.slide-up-in` | translateY(16px) + opacity 0→0 |
| `.slide-in-right` | translateX(-12px) |
| `.slide-in-left` | translateX(12px) |
| `.scale-in` | scale(0.95) + opacity |
| `.anim-stagger` | 子元素依次延迟 0-360ms |

所有动画持续 `var(--anim-duration, 150ms)`，缓动 `cubic-bezier(0.16, 1, 0.3, 1)`。
