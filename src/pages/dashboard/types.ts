import type { ReactNode } from 'react'

export interface WidgetProps {
  extra?: {
    refresh?: () => void
  }
  children?: ReactNode
}
