import { useEffect, useState } from 'react'

/**
 * 读取并订阅应用级「组件材质」与模糊强度。
 *
 * 材质由宿主在 `document.documentElement.dataset.material` 上设置
 * （取值 default / frosted / aero / liquid），模糊强度从 `--glass-blur` CSS 变量读取。
 * 用 MutationObserver 监听根元素上属性和行内样式的变化，材质/强度变更时触发重渲染，
 * 使本组件库内的表面（如 Card）能切换为 `liquid` 的 LiquidGlass 渲染。
 *
 * @returns { material, glassBlur } 当前材质；glassBlur 为像素数（默认 18）。
 */
export function useMaterial(): { material: string; glassBlur: number } {
  const read = (): { material: string; glassBlur: number } => {
    const root = document.documentElement
    const glassBlur = parseFloat(root.style.getPropertyValue('--glass-blur')) || 18
    return { material: root.dataset.material ?? 'default', glassBlur }
  }
  const [state, setState] = useState<{ material: string; glassBlur: number }>(read)

  useEffect(() => {
    setState(read())
    const root = document.documentElement
    const observer = new MutationObserver(() => setState(read()))
    if (root) {
      observer.observe(root, { attributes: true, attributeFilter: ['data-material', 'style'] })
    }
    return () => observer.disconnect()
  }, [])

  return state
}
