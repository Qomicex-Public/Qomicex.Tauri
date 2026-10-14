import { createContext, useContext } from 'react'

/** localStorage 键名：侧边栏是否展开 */
const SIDEBAR_EXPANDED_KEY = 'qomicex.sidebar.expanded'

/** 默认收起。仅存储值为字符串 'true' 时判定为展开 */
export const SIDEBAR_EXPANDED_DEFAULT = false

function loadSidebarExpanded(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_EXPANDED_KEY) === 'true'
  } catch {
    return SIDEBAR_EXPANDED_DEFAULT
  }
}

function saveSidebarExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_EXPANDED_KEY, String(expanded))
  } catch {
    /* 忽略隐私模式写入失败 */
  }
}

export interface SidebarExpansionContextValue {
  expanded: boolean
  setExpanded: (expanded: boolean) => void
}

/**
 * 默认值取收起 + no-op setter（不抛错）：Provider 之外读取时降级，
 * 避免独立挂载的插件插槽在没有 Provider 的宿主里直接崩掉。
 */
export const SidebarExpansionContext = createContext<SidebarExpansionContextValue>({
  expanded: SIDEBAR_EXPANDED_DEFAULT,
  setExpanded: () => {},
})

export function useSidebarExpanded(): SidebarExpansionContextValue {
  return useContext(SidebarExpansionContext)
}

export { loadSidebarExpanded, saveSidebarExpanded }
