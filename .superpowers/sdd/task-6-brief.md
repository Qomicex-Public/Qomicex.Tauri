### Task 6: 前端 — ContextMenu 右键菜单组件

**Files:**
- Create: `src/components/ContextMenu.tsx`

**Interfaces:**
- Produces: `<ContextMenu items targetRef>` — 在元素上右键时显示菜单，点击外部关闭

- [ ] **Step 1: 创建 ContextMenu 组件**

```tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils.ts'

export interface ContextMenuItem {
  label: string
  icon?: any
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

export interface ContextMenuProps {
  items: ContextMenuItem[]
  children: React.ReactNode
}

export function ContextMenu({ items, children }: ContextMenuProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setPos({ x: e.clientX, y: e.clientY })
    setOpen(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    let { x, y } = pos
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8
    menuRef.current.style.left = `${x}px`
    menuRef.current.style.top = `${y}px`
  }, [open, pos])

  return (
    <>
      <div onContextMenu={onContextMenu}>{children}</div>
      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-lg animate-in fade-in zoom-in-95"
          style={{ left: pos.x, top: pos.y }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => { item.onClick(); setOpen(false) }}
              disabled={item.disabled}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                item.danger
                  ? 'text-destructive hover:bg-destructive/10'
                  : 'text-popover-foreground hover:bg-accent',
                item.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ContextMenu.tsx
git commit -m "feat: add ContextMenu right-click menu component"
```
