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
 * - Shift 单击：从上次点击处范围选择（锚点按**稳定键**查找，见下）
 * - Ctrl/Shift 点击视为「多选意图」→ 进入选择模式（复选框常驻）
 * - Ctrl/Cmd+A：全选（输入框内不劫持）
 * - Esc：清空选择并退出选择模式
 *
 * `items` 应传入当前**过滤后**的列表（搜索/筛选生效），使范围选择与全选
 * 只作用于可见项。`getKey` 取列表项的稳定键（fileName / filePath / name）。
 *
 * 两条与「列表会变」相关的约束（均由代码审查发现，勿回退）：
 * 1. `items` 变化时清理 `selected` 中已不可见的键——否则筛选/搜索后，隐藏项
 *    仍被批量工具栏计为已选，批量删除更会真的删掉用户看不见的行。
 * 2. 上次点击的锚点存**稳定键**而非索引——列表重排/筛选后索引会指向别的项
 *    （范围选错），旧索引越界时还会取到 `undefined` 抛异常。
 */
export function useListSelection<T>(items: T[], getKey: (item: T) => string) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /**
   * 批量选择模式（复选框常驻）。只由「显式多选意图」进入：工具栏按钮、
   * Ctrl/Shift 点击、Ctrl+A。不用 selected.size > 0 推导——否则单击一行
   * 会让整列表立刻布满复选框。
   */
  const [selectMode, setSelectMode] = useState(false)
  /** 上次点击的稳定键（null = 尚无锚点）。失效时范围选择回退为单击。 */
  const lastClickedKeyRef = useRef<string | null>(null)

  // items / getKey 每次渲染都可能是新引用（调用方常传内联箭头函数）。
  // 放进 ref 让回调与事件监听保持稳定标识，避免逐渲染重注册 keydown。
  const itemsRef = useRef(items)
  itemsRef.current = items
  const getKeyRef = useRef(getKey)
  getKeyRef.current = getKey

  // 过滤/排序变化后，剔除已不可见的选中键（约束 1）。
  // 仅依赖 items：getKey 经 ref 读取，故内联箭头不会导致逐渲染执行；
  // 无变化时返回原引用，React 会跳过更新，不会形成循环。
  useEffect(() => {
    const keyOf = getKeyRef.current
    const visible = new Set(itemsRef.current.map(keyOf))
    setSelected(prev => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set<string>()
      for (const k of prev) {
        if (visible.has(k)) next.add(k)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [items])

  const toggleSelect = useCallback((key: string, shift?: boolean, ctrl?: boolean) => {
    const list = itemsRef.current
    const keyOf = getKeyRef.current
    const index = list.findIndex(it => keyOf(it) === key)
    if (index === -1) return
    if (shift || ctrl) setSelectMode(true)
    // 锚点按稳定键在当前列表中查找；锚点已不可见时 prevIndex = -1，范围分支跳过，
    // 自然退化为「只选中本行」（约束 2）。
    const anchorKey = lastClickedKeyRef.current
    const prevIndex = anchorKey === null ? -1 : list.findIndex(it => keyOf(it) === anchorKey)
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && prevIndex >= 0) {
        const start = Math.min(prevIndex, index)
        const end = Math.max(prevIndex, index)
        for (let i = start; i <= end; i++) {
          const it = list[i]
          if (it !== undefined) next.add(keyOf(it))
        }
      } else if (ctrl) {
        if (next.has(key)) next.delete(key); else next.add(key)
      } else {
        next.clear()
        next.add(key)
      }
      return next
    })
    lastClickedKeyRef.current = key
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
    lastClickedKeyRef.current = null
  }, [])

  /** 全选当前可见项 */
  const selectAll = useCallback(() => {
    const keyOf = getKeyRef.current
    setSelected(new Set(itemsRef.current.map(keyOf)))
  }, [])

  // 统一不变量：选中项为空 ⇒ 退出选择模式（复选框阵列不空挂）。
  // 工具栏「取消选择」走 clear()、Esc 走 keydown，均已显式退出；这里补上
  // 「勾选/再勾选取消最后一项」路径——勾选全取消后与工具栏行为保持一致。
  useEffect(() => {
    if (selected.size === 0) setSelectMode(false)
  }, [selected])
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
        lastClickedKeyRef.current = null
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return { selected, setSelected, selectMode, setSelectMode, toggleSelect, handleDragSelect, clear, selectAll }
}
