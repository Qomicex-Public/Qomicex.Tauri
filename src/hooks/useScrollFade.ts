import { useEffect, useRef, useState } from 'react'

export function useScrollFade() {
  const ref = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    function check() {
      const threshold = 16
      setAtBottom(el!.scrollHeight - el!.scrollTop - el!.clientHeight < threshold)
    }
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', check)
      ro.disconnect()
    }
  }, [])

  return { ref, fadeClass: atBottom ? '' : 'scroll-fade-mask' }
}
