import { BatchToolbar } from '../components/ui'
import { useI18n } from '../i18n/index.tsx'
import type { ReactNode } from 'react'

export function I18nBatchToolbar(props: {
  selectedCount: number
  onClear: () => void
  onSelectAll?: () => void
  children?: ReactNode
  className?: string
}) {
  const { t } = useI18n()
  return (
    <BatchToolbar
      {...props}
      messages={{
        selected: t('common.batchSelected'),
        selectAll: t('common.selectAll'),
        clear: t('common.deselect'),
      }}
    />
  )
}