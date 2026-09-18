import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 资源列表多选状态机（各资源页签共用）。
 *
 * 原先 6 个资源页签各写一份 selection/拖选逻辑，行为互有出入（例如「原理图」页签
 * 缺少拖选、只有 ModsTab 支持 Ctrl+A/Esc）。集中到此处后各页签行为一致。
 *
 * 语义（与 ModsTab 对齐）：
 * - 普通单击：替换选择（只选中该行）
 * - Ctrl/Cmd 单击：切换该行
 * - Shift 单击：从上次点击处范围选择
 * - Ctrl/Shift 点击视为「多选意图」→ 进入选择模式（复选框常驻）
 * - Ctrl/Cmd+A：全选（输入框内不劫持）
 * - Esc：清空选择并退出选择模式
 *
 * `items` 应传入当前**过滤后**的列表（搜索/筛选生效），使范围选择与全选
 * 只作用于可见项。`getKey` 取列表项的稳定键（fileName / filePath / name）。
 */
export function useListSelection<T>(items: T[], getKey: (item: T) => string) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /**
   * 批量选择模式（复选框常驻）。只由「显式多选意图」进入：工具栏按钮、
   * Ctrl/Shift 点击、Ctrl+A。不用 selected.size > 0 推导——否则单击一行
   * 会让整列表立刻布满复选框。
   */
  const [selectMode, setSelectMode] = useState(false)
  const lastClickedRef = useRef(-1)

  // items / getKey 每次渲染都可能是新引用（调用方常传内联箭头函数）。
  // 放进 ref 让回调与事件监听保持稳定标识，避免逐渲染重注册 keydown。
  const itemsRef = useRef(items)
  itemsRef.current = items
  const getKeyRef = useRef(getKey)
  getKeyRef.current = getKey

  const toggleSelect = useCallback((key: string, shift?: boolean, ctrl?: boolean) => {
    const list = itemsRef.current
    const keyOf = getKeyRef.current
    const index = list.findIndex(it => keyOf(it) === key)
    if (index === -1) return
    if (shift || ctrl) setSelectMode(true)
    const prevLastClicked = lastClickedRef.current
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && prevLastClicked >= 0) {
        const start = Math.min(prevLastClicked, index)
        const end = Math.max(prevLastClicked, index)
        for (let i = start; i <= end; i++) next.add(keyOf(list[i]))
      } else if (ctrl) {
        if (next.has(key)) next.delete(key); else next.add(key)
      } else {
        next.clear()
        next.add(key)
      }
      return next
    })
    lastClickedRef.current = index
  }, [])

  /** 拖动框选：Shift 追加，普通替换（DragSelectArea 回调） */
  const handleDragSelect = useCallback((keys: string[], mode: 'replace' | 'add') => {
    setSelected(prev => {
      const next = new Set(prev)
      if (mode === 'add') {
        keys.forEach(k => next.add(k))
      } else {
        next.clear()
        keys.forEach(k => next.add(k))
      }
      return next
    })
  }, [])

  /** 清空选择并退出选择模式（Esc / 批量操作完成后） */
  const clear = useCallback(() => {
    setSelected(new Set())
    setSelectMode(false)
  }, [])

  /** 全选当前可见项 */
  const selectAll = useCallback(() => {
    const keyOf = getKeyRef.current
    setSelected(new Set(itemsRef.current.map(keyOf)))
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      // 输入框内不劫持：搜索框里的 Ctrl+A 应选中文本、Esc 应交给输入框自身处理
      const inInput = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      // Ctrl/Cmd+A 全选（仅本 tab 挂载时生效；TabContent 非激活即卸载，不会跨 tab 干扰）
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        if (inInput) return
        e.preventDefault()
        setSelectMode(true)
        const keyOf = getKeyRef.current
        setSelected(new Set(itemsRef.current.map(keyOf)))
        return
      }
      // Esc 退出批量选择（清空选中 + 关闭常驻复选框）
      if (e.key === 'Escape' && !inInput) {
        setSelected(new Set())
        setSelectMode(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return { selected, setSelected, selectMode, setSelectMode, toggleSelect, handleDragSelect, clear, selectAll }
}
