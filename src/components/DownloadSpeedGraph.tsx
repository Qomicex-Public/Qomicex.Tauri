import { useEffect, useRef, useState } from 'react'
import { formatSpeed } from '../lib/download-format.ts'

const SAMPLE_MS = 500
const MAX_POINTS = 40

interface DownloadSpeedGraphProps {
  speed: number
  className?: string
}

/**
 * 下载速度 sparkline：每 500ms 采样一次当前速度（约 20s 窗口），
 * 手绘 SVG 面积图，无第三方图表依赖。颜色跟随父级文字色（currentColor）。
 */
export default function DownloadSpeedGraph({ speed, className }: DownloadSpeedGraphProps) {
  const speedRef = useRef(speed)
  speedRef.current = speed
  const [history, setHistory] = useState<number[]>([])

  useEffect(() => {
    const id = setInterval(() => {
      setHistory((h) => [...h.slice(-(MAX_POINTS - 1)), speedRef.current])
    }, SAMPLE_MS)
    return () => clearInterval(id)
  }, [])

  const max = Math.max(...history, 1)
  const n = history.length
  const px = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100)
  const py = (v: number) => 100 - (v / max) * 92 - 4
  const linePath = history.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(2)},${py(v).toFixed(2)}`).join(' ')
  const areaPath = n > 1 ? `${linePath} L100,100 L0,100 Z` : ''

  return (
    <div className={className}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-12 w-full" aria-hidden="true">
        {areaPath && <path d={areaPath} className="fill-current opacity-15" />}
        {n > 1 && (
          <path
            d={linePath}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        )}
      </svg>
      <div className="mt-1 text-right text-[10px] tabular-nums text-muted-foreground">
        {formatSpeed(speed) || '—'}
      </div>
    </div>
  )
}
