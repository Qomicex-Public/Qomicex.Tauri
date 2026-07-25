export function createRafThrottle(maxFps: number) {
  const rafId = { current: 0 }
  if (maxFps <= 0) {
    return { throttle: (fn: FrameRequestCallback) => { rafId.current = requestAnimationFrame(fn) }, rafId }
  }
  const interval = 1000 / maxFps
  let lastTime = 0
  let pending: FrameRequestCallback | null = null

  function loop(time: number) {
    if (!pending) return
    if (time - lastTime >= interval) {
      lastTime = time
      const cb = pending
      pending = null
      cb(time)
    } else {
      rafId.current = requestAnimationFrame(loop)
    }
  }

  return {
    throttle: (fn: FrameRequestCallback) => {
      pending = fn
      rafId.current = requestAnimationFrame(loop)
    },
    rafId,
  }
}
