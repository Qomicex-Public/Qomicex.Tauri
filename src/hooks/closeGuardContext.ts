// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { createContext, useContext } from 'react'

export const CloseGuardContext = createContext<() => Promise<void>>(async () => {})

export function useSafeClose() {
  return useContext(CloseGuardContext)
}
