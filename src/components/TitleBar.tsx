import { getCurrentWindow } from '@tauri-apps/api/window'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMinus, faSquare, faWindowMaximize, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useState } from 'react'

const win = getCurrentWindow()

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    win.onResized(() => { win.isMaximized().then(setMaximized) })
    win.isMaximized().then(setMaximized)
  }, [])

  return (
    <div data-tauri-drag-region className="flex h-9 shrink-0 items-center justify-end border-b border-border/50 bg-background/50 backdrop-blur-sm select-none">
      <div className="flex">
        <button onClick={() => win.minimize()} className="flex h-9 w-11 items-center justify-center text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground">
          <FontAwesomeIcon icon={faMinus} className="h-3 w-3" />
        </button>
        <button onClick={() => win.toggleMaximize()} className="flex h-9 w-11 items-center justify-center text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground">
          <FontAwesomeIcon icon={maximized ? faWindowMaximize : faSquare} className="h-3 w-3" />
        </button>
        <button onClick={() => win.close()} className="flex h-9 w-11 items-center justify-center text-muted-foreground/60 transition-colors hover:bg-destructive/80 hover:text-destructive-foreground">
          <FontAwesomeIcon icon={faXmark} className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
