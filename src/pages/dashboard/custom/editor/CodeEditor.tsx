// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    callbacks.current = { value, onChange, onSave, onStatus, getDefs, getTsContext }
  })

  useEffect(() => {
    let disposed = false
    setLoadError(false)
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
    }).catch((error) => {
      if (disposed) return
      console.error('[widget-editor] 加载编辑器失败', error)
      setLoadError(true)
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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' && event.key !== 'Enter') return
    const tooltip = hostRef.current?.querySelector('.cm-tooltip-autocomplete')
    if (!tooltip) return
    const items = tooltip.querySelectorAll('li')
    if (items.length === 0) return
    const selected = (tooltip.querySelector('li[aria-selected="true"]') ?? items[0]) as HTMLElement
    const label = selected.querySelector('.cm-completionLabel')?.textContent ?? selected.textContent ?? ''
    if (!label) return
    event.preventDefault()
    event.stopPropagation()
    handleRef.current?.insertCompletion(label.trim())
  }

  if (loadError) {
    return (
      <textarea
        value={value}
        onChange={(event) => callbacks.current.onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            callbacks.current.onSave?.()
          }
        }}
        spellCheck={false}
        style={{ height: 'min(420px, 45vh)' }}
        className={cn(
          'w-full resize-none rounded-md border border-input bg-background/60 p-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          className,
        )}
      />
    )
  }

  return (
    <div
      ref={hostRef}
      onKeyDownCapture={handleKeyDown}
      style={{ height: 'min(420px, 45vh)' }}
      className={cn(
        'overflow-hidden rounded-md border border-input bg-background/60 text-xs shadow-sm focus-within:ring-1 focus-within:ring-ring',
        className,
      )}
    />
  )
}
