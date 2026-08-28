import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'
import { MorphIcon } from 'morphicons/react'
import { useSafeClose } from '../hooks/closeGuardContext.ts'

const win = getCurrentWindow()

const MAXIMIZE_ICON = 'M4.5 4.5h15v15h-15z'
const RESTORE_ICON = 'M9.5 9.5h10v10h-10zM4.5 4.5h10v10h-10z'

function MinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="1.5" y="5.5" width="9" height="1" fill="currentColor" />
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
          <MorphIcon icon={maximized ? RESTORE_ICON : MAXIMIZE_ICON} size={12} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" spring="snappy" reducedMotion="user" />
        </button>
        <button onClick={safeClose} className="flex h-9 w-11 items-center justify-center rounded-[4px] text-muted-foreground/60 transition-all duration-150 hover:bg-destructive/80 hover:text-destructive-foreground active:bg-destructive">
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
