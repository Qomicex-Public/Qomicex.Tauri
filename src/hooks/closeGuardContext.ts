import { createContext, useContext } from 'react'

export const CloseGuardContext = createContext<() => Promise<void>>(async () => {})

export function useSafeClose() {
  return useContext(CloseGuardContext)
}
