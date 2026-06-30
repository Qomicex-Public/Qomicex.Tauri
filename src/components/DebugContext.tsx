import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export interface DebugState {
  disableAnimations: boolean
  showComponentBoundaries: boolean
  simulateApiErrors: boolean
  networkLogging: boolean
  disableCaching: boolean
}

const INITIAL: DebugState = {
  disableAnimations: false,
  showComponentBoundaries: false,
  simulateApiErrors: false,
  networkLogging: false,
  disableCaching: false,
}

interface DebugContextValue {
  state: DebugState
  toggle: (key: keyof DebugState) => void
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

  return <ctx.Provider value={{ state, toggle }}>{children}</ctx.Provider>
}

export function useDebug() {
  return useContext(ctx)
}
