import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { getDefaultInstance } from '../../api/instance.ts'
import { getDefaultAccount } from '../../api/account.ts'
import { ApiError } from '../../api/client.ts'
import { useRunning } from '../../contexts/RunningContext.tsx'
import { useRequireDefaultAccount } from '../../hooks/useRequireDefaultAccount.ts'
import { useI18n } from '../../i18n/index.tsx'
import type { GameInstance, Account } from '../../types/index.ts'

export type WidgetId =
  | 'watermark'
  | 'account'
  | 'announcements'
  | 'instance'
  | 'launch'
  | `plugin:${string}`

export interface WidgetLayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  hidden?: boolean
}

export interface WidgetDefinition {
  id: WidgetId
  defaultLayout: { x: number; y: number; w: number; h: number }
  minW?: number
  minH?: number
  maxW?: number
  maxH?: number
}

export const DEFAULT_WIDGETS: WidgetDefinition[] = [
  { id: 'watermark', defaultLayout: { x: 1, y: 2, w: 2, h: 4 }, minW: 1, minH: 1, maxW: 4, maxH: 6 },
  { id: 'account', defaultLayout: { x: 3, y: 0, w: 1, h: 1 }, minW: 1, minH: 1, maxH: 3 },
  { id: 'instance', defaultLayout: { x: 0, y: 7, w: 4, h: 1 }, minW: 1, minH: 1, maxH: 2 },
  { id: 'announcements', defaultLayout: { x: 3, y: 1, w: 1, h: 2 }, minW: 1, minH: 1, maxH: 3 },
]

const STORAGE_KEY = 'qomicex.dashboard.layout.v3'

function defaultLayoutItems(): WidgetLayoutItem[] {
  return DEFAULT_WIDGETS.map(d => ({
    i: d.id, x: d.defaultLayout.x, y: d.defaultLayout.y,
    w: d.defaultLayout.w, h: d.defaultLayout.h,
  }))
}

/** 旧版本存储键 → 当前键迁移（升键时不丢用户已编辑的布局） */
const LEGACY_STORAGE_KEYS = ['qomicex.dashboard.layout.v2', 'qomicex.dashboard.layout.v1']

function loadLayout(): WidgetLayoutItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as WidgetLayoutItem[]
      if (Array.isArray(parsed)) return parsed
    }
    for (const legacyKey of LEGACY_STORAGE_KEYS) {
      const legacyRaw = localStorage.getItem(legacyKey)
      if (!legacyRaw) continue
      try {
        const legacy = JSON.parse(legacyRaw) as WidgetLayoutItem[]
        if (Array.isArray(legacy)) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy))
          return legacy
        }
      } catch { /* 忽略损坏的旧数据 */ }
    }
  } catch { /* ignore */ }
  return defaultLayoutItems()
}

function persist(l: WidgetLayoutItem[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(l)) } catch { /* ignore */ }
}

interface DashboardContextValue {
  defaultInstance: GameInstance | null
  defaultAccount: Account | null
  refresh: () => void
  launch: (instance: GameInstance) => Promise<void>
  showMicrosoftReauth: boolean
  setShowMicrosoftReauth: (v: boolean) => void
  needsAccount: ReturnType<typeof useRequireDefaultAccount>['needsAccount']
  resolveAccountCheck: () => Promise<boolean>
  showNoAccount: boolean
  showSelectAccount: boolean
  handleAddAccount: () => void
  handleGoToAccounts: () => void
  handleCancelNoAccount: () => void
  handleCancelSelect: () => void
  handleSelectAccount: (account: Account) => void
  layout: WidgetLayoutItem[]
  setLayout: (l: WidgetLayoutItem[]) => void
  editing: boolean
  setEditing: (v: boolean) => void
  hiddenWidgets: WidgetId[]
  hideWidget: (id: WidgetId) => void
  restoreWidget: (id: WidgetId) => void
  resetLayout: () => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function useDashboard() {
  const ctx = useContext(DashboardContext)
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider')
  return ctx
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const { launchInstance, showLaunchError } = useRunning()
  const [defaultInstance, setDefaultInstance] = useState<GameInstance | null>(null)
  const [defaultAccount, setDefaultAccountState] = useState<Account | null>(null)
  const [showMicrosoftReauth, setShowMicrosoftReauth] = useState(false)
  const [layout, setLayoutState] = useState<WidgetLayoutItem[]>(loadLayout)
  const [editing, setEditing] = useState(false)
  const accountCheck = useRequireDefaultAccount()

  const refresh = useCallback(() => {
    getDefaultInstance().then(inst => setDefaultInstance(inst)).catch(() => {})
    getDefaultAccount().then(acc => setDefaultAccountState(acc as Account | null)).catch(() => {})
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const launch = useCallback(async (inst: GameInstance) => {
    if (accountCheck.needsAccount) {
      const ok = await accountCheck.resolve()
      if (!ok) return
    }
    try {
      await launchInstance(inst.id, inst.name, { path: inst.javaPath, gameVersion: inst.gameVersion, gameDir: inst.gameDir })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = e instanceof ApiError ? e.code : ''
      if (msg.includes('TOKEN_EXPIRED') || msg.includes('invalid_grant') || msg.includes('AADSTS70008') || code.includes('TOKEN_EXPIRED')) {
        setShowMicrosoftReauth(true)
        return
      }
      if (code.includes('NETWORK_ERROR')) {
        showLaunchError(t('running.launchFailedTitle'), t('errors.networkError'))
        return
      }
      showLaunchError(t('running.launchFailedTitle'), e instanceof Error ? e.message : String(e))
    }
  }, [accountCheck, launchInstance, showLaunchError, t])

  const setLayout = useCallback((l: WidgetLayoutItem[]) => {
    setLayoutState(l)
    persist(l)
  }, [])

  const hideWidget = useCallback((id: WidgetId) => {
    setLayoutState(prev => {
      const next = prev.map(it => it.i === id ? { ...it, hidden: true } : it)
      persist(next)
      return next
    })
  }, [])

  const restoreWidget = useCallback((id: WidgetId) => {
    setLayoutState(prev => {
      const next = prev.map(it => it.i === id ? { ...it, hidden: false } : it)
      persist(next)
      return next
    })
  }, [])

  const resetLayout = useCallback(() => {
    const fresh = defaultLayoutItems()
    setLayoutState(fresh)
    persist(fresh)
  }, [])

  const hiddenWidgets = layout.filter(it => it.hidden).map(it => it.i as WidgetId)

  return (
    <DashboardContext.Provider value={{
      defaultInstance, defaultAccount, refresh, launch,
      showMicrosoftReauth, setShowMicrosoftReauth,
      needsAccount: accountCheck.needsAccount,
      resolveAccountCheck: accountCheck.resolve,
      showNoAccount: accountCheck.showNoAccount,
      showSelectAccount: accountCheck.showSelectAccount,
      handleAddAccount: accountCheck.handleAddAccount,
      handleGoToAccounts: accountCheck.handleGoToAccounts,
      handleCancelNoAccount: accountCheck.handleCancelNoAccount,
      handleCancelSelect: accountCheck.handleCancelSelect,
      handleSelectAccount: accountCheck.handleSelectAccount,
      layout, setLayout, editing, setEditing,
      hiddenWidgets, hideWidget, restoreWidget, resetLayout,
    }}>
      {children}
    </DashboardContext.Provider>
  )
}

export interface WidgetSize {
  w: number
  h: number
}

const WidgetSizeContext = createContext<WidgetSize>({ w: 2, h: 1 })

export function useWidgetSize(): WidgetSize {
  return useContext(WidgetSizeContext)
}

export function WidgetSizeProvider({ size, children }: { size: WidgetSize; children: ReactNode }) {
  return <WidgetSizeContext.Provider value={size}>{children}</WidgetSizeContext.Provider>
}
