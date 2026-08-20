import * as React from "react"
import { cn } from "../lib/cn.js"
import { useMaterial } from "../lib/useMaterial.js"
import { LiquidGlass } from "quidlass"

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { material, glassBlur } = useMaterial()
    const liquid = material === "liquid"
    // 默认/毛玻璃/Aero：普通 div + bg-card（默认材质用它撑住不透明卡片底色）+ glass-surface。
    // 液态玻璃：交给 LiquidGlass 渲染自带玻璃表面，不再叠加 bg-card/glass-surface。
    const cls = liquid
      ? cn("rounded-xl border border-border text-card-foreground shadow", className)
      : cn("rounded-xl border border-border bg-card text-card-foreground shadow glass-surface", className)

    if (liquid) {
      // 液态玻璃：用 quidlass 的 LiquidGlass 画布/位移实现真液态扭曲与弹性。
      // 该组件自带容器（relative/overflow-hidden/blur/位移 SVG 滤镜），不再加 .glass-surface。
      return (
        <LiquidGlass
          {...props}
          className={cls}
          borderRadius={16}
          blur={Math.max(1, glassBlur * 0.6)}
          contrast={1.15}
          brightness={1.05}
          saturation={1.1}
          shadowIntensity={0.22}
          elasticity={0.12}
          enableInnerGlow={false}
        />
      )
    }

    return <div ref={ref} className={cls} {...props} />
  }
)
Card.displayName = "Card"

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
  )
)
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
  )
)
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
)
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  )
)
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  )
)
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
