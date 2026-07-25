import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'
import { useSafeClose } from '../hooks/closeGuardContext.ts'

const win = getCurrentWindow()

function MinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="1.5" y="5.5" width="9" height="1" fill="currentColor" />
    </svg>
  )
}

function MaxIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.15" fill="none" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="3" y="0.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.15" fill="none" />
      <rect x="0.5" y="3" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.15" fill="none" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const safeClose = useSafeClose()

  useEffect(() => {
    win.onResized(() => { win.isMaximized().then(setMaximized) })
    win.isMaximized().then(setMaximized)
  }, [])

  return (
    <div data-tauri-drag-region className="flex h-9 shrink-0 items-center justify-end bg-background/50 backdrop-blur-sm select-none">
      <div className="flex">
        <button onClick={() => win.minimize()} className="flex h-9 w-11 items-center justify-center rounded-[4px] text-muted-foreground/60 transition-all duration-150 hover:bg-white/10 hover:text-foreground active:bg-white/20">
          <MinIcon />
        </button>
        <button onClick={() => win.toggleMaximize()} className="flex h-9 w-11 items-center justify-center rounded-[4px] text-muted-foreground/60 transition-all duration-150 hover:bg-white/10 hover:text-foreground active:bg-white/20">
          {maximized ? <RestoreIcon /> : <MaxIcon />}
        </button>
        <button onClick={safeClose} className="flex h-9 w-11 items-center justify-center rounded-[4px] text-muted-foreground/60 transition-all duration-150 hover:bg-destructive/80 hover:text-destructive-foreground active:bg-destructive">
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
