// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ReactNode } from 'react'

export interface WidgetProps {
  extra?: {
    refresh?: () => void
  }
  children?: ReactNode
}
