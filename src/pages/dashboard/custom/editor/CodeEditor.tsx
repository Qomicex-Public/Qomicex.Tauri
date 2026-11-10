// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from 'react'
import { cn } from '../../../../components/ui'
import type { CustomWidgetDef } from '../store.ts'
import type { EditorHandle, EditorStatus, TsCompletionContext } from './create-editor.ts'

interface CodeEditorProps {
  value: string
  language: 'xml' | 'ts'
  getDefs: () => CustomWidgetDef[]
  getTsContext: () => TsCompletionContext
  onChange: (value: string) => void
  onSave?: () => void
  onStatus?: (status: EditorStatus) => void
  className?: string
}

export function CodeEditor({
  value,
  language,
  getDefs,
  getTsContext,
  onChange,
  onSave,
  onStatus,
  className,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<EditorHandle | null>(null)
  const callbacks = useRef({ value, onChange, onSave, onStatus, getDefs, getTsContext })
  callbacks.current = { value, onChange, onSave, onStatus, getDefs, getTsContext }

  useEffect(() => {
    let disposed = false
    void import('./create-editor.ts').then((module) => {
      if (disposed || !hostRef.current) return
      handleRef.current = module.mountEditor(hostRef.current, {
        value: callbacks.current.value,
        language,
        getDefs: () => callbacks.current.getDefs(),
        getTsContext: () => callbacks.current.getTsContext(),
        onChange: (next) => callbacks.current.onChange(next),
        onSave: () => callbacks.current.onSave?.(),
        onStatus: (status) => callbacks.current.onStatus?.(status),
      })
    })
    return () => {
      disposed = true
      handleRef.current?.destroy()
      handleRef.current = null
    }
  }, [language])

  useEffect(() => {
    handleRef.current?.setValue(value)
  }, [value])

  return (
    <div
      ref={hostRef}
      style={{ height: 'min(420px, 45vh)' }}
      className={cn(
        'overflow-hidden rounded-md border border-input bg-background/60 text-xs shadow-sm focus-within:ring-1 focus-within:ring-ring',
        className,
      )}
    />
  )
}
