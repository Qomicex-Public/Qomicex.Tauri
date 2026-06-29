import { useEffect, useRef } from 'react'
import { SkinViewer } from 'skinview3d'

interface Props {
  textureUrl: string
  model?: 'classic' | 'slim'
  className?: string
  width?: number
  height?: number
}

export function SkinViewer3D({ textureUrl, model = 'classic', className, width = 300, height = 400 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<SkinViewer | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const viewer = new SkinViewer({
      canvas: canvasRef.current,
      width,
      height,
      skin: textureUrl,
      model: model === 'slim' ? 'slim' : 'default',
    })
    viewer.autoRotate = true
    viewer.autoRotateSpeed = 0.5
    viewerRef.current = viewer
    return () => { viewer.dispose() }
  }, [width, height])

  useEffect(() => {
    if (viewerRef.current) {
      viewerRef.current.loadSkin(textureUrl, { model: model === 'slim' ? 'slim' : 'default' })
    }
  }, [textureUrl, model])

  return <canvas ref={canvasRef} className={className} />
}
