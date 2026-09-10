import * as React from "react"
import { cn } from "../lib/cn.js"

interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  /** 文本内容变化时播放切换动画（默认开启）；设 false 关闭 */
  animate?: boolean
}

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, animate = true, children, ...props }, ref) => {
    // 仅对纯文本内容做切换动画：用文本作 key，内容变更即重挂载并重放入场动画
    const text = typeof children === "string" || typeof children === "number" ? String(children) : null
    return (
      <label
        ref={ref}
        className={cn(
          "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
          className
        )}
        {...props}
      >
        {animate && text !== null ? (
          <span key={text} className="inline-block animate-label-swap">{children}</span>
        ) : (
          children
        )}
      </label>
    )
  }
)
Label.displayName = "Label"

export { Label }
