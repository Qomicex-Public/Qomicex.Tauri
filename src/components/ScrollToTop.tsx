import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronUp } from '@fortawesome/free-solid-svg-icons'
import { cn } from '../lib/utils.ts'

function getScrollEl(): HTMLElement {
  const main = document.querySelector('main')
  if (!main) return document.documentElement
  for (const child of main.children) {
    if (child instanceof HTMLElement) {
      const style = getComputedStyle(child)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return child
      }
    }
  }
  return main
}

export default function ScrollToTop() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let rafId: number
    const poll = () => {
      const el = getScrollEl()
      setVisible(el.scrollTop > 400)
      rafId = requestAnimationFrame(poll)
    }
    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <button
      onClick={() => getScrollEl().scrollTo({ top: 0, behavior: 'smooth' })}
      className={cn(
        'fixed bottom-6 right-6 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-border/50 bg-background/70 text-foreground shadow-lg backdrop-blur-md transition-all duration-300',
        visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
      )}
    >
      <FontAwesomeIcon icon={faChevronUp} className="h-4 w-4" />
    </button>
  )
}
