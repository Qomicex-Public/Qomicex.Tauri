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
  capeUrl?: string | null
  showCape?: boolean
}

export function SkinViewer3D({ textureUrl, model = 'classic', className, width = 300, height = 400, name, showNameTag = true, background = 'rgb(30,30,37)', panoramaUrl, zoom = 0.7, capeUrl = null, showCape = true }: Props) {
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

  // 披风加载/重置：源变化时重新加载，开关控制可见性
  useEffect(() => {
    if (!viewerRef.current) return
    const v = viewerRef.current
    if (!capeUrl) {
      v.resetCape()
      return
    }
    v.loadCape(capeUrl).catch(() => {})
    return () => { v.resetCape() }
  }, [capeUrl])

  useEffect(() => {
    if (viewerRef.current?.playerObject) {
      viewerRef.current.playerObject.cape.visible = showCape && !!capeUrl
    }
  }, [showCape, capeUrl])

  return <canvas ref={canvasRef} className={className} />
}
