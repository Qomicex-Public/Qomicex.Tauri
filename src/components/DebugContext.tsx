import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export interface DebugState {
  unlocked: boolean
  disableAnimations: boolean
  showComponentBoundaries: boolean
  simulateApiErrors: boolean
  networkLogging: boolean
  disableCaching: boolean
}

const INITIAL: DebugState = {
  unlocked: false,
  disableAnimations: false,
  showComponentBoundaries: false,
  simulateApiErrors: false,
  networkLogging: false,
  disableCaching: false,
}

interface DebugContextValue {
  state: DebugState
  toggle: (key: keyof DebugState) => void
  unlock: () => void
}

const ctx = createContext<DebugContextValue>({ state: INITIAL, toggle: () => {} })

declare global {
  interface Window {
    __DEBUG__: DebugState
  }
}


export function DebugProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DebugState>(window.__DEBUG__ ?? { ...INITIAL })

  const toggle = useCallback((key: keyof DebugState) => {
    setState(prev => {
      const next = { ...prev, [key]: !prev[key] }
      window.__DEBUG__ = next
      return next
    })
  }, [])

  const unlock = useCallback(() => {
    setState(prev => {
      if (prev.unlocked) return prev
      const next = { ...prev, unlocked: true }
      window.__DEBUG__ = next
      return next
    })
  }, [])

  return <ctx.Provider value={{ state, toggle, unlock }}>{children}</ctx.Provider>
}

export function useDebug() {
  return useContext(ctx)
}
