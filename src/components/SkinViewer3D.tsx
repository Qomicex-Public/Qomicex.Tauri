import { useEffect, useRef } from 'react'
import { SkinViewer } from 'skinview3d'

interface Props {
  textureUrl: string
  model?: 'classic' | 'slim'
  className?: string
  width?: number
  height?: number
  name?: string
  showNameTag?: boolean
  background?: string | number
  panoramaUrl?: string
  zoom?: number
}

export function SkinViewer3D({ textureUrl, model = 'classic', className, width = 300, height = 400, name, showNameTag = true, background = 'rgb(30,30,37)', panoramaUrl, zoom = 0.7 }: Props) {
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
      background,
      panorama: panoramaUrl,
      zoom,
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

  useEffect(() => {
    if (viewerRef.current) {
      viewerRef.current.nameTag = name && showNameTag ? name : null
    }
  }, [name, showNameTag])

  useEffect(() => {
    if (viewerRef.current && panoramaUrl) {
      viewerRef.current.loadPanorama(panoramaUrl)
    }
  }, [panoramaUrl])

  return <canvas ref={canvasRef} className={className} />
}
