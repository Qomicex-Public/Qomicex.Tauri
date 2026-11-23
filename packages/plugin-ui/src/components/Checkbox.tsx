// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { cn } from "../lib/cn.js"

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, style, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "anim-transition peer h-4 w-4 shrink-0 rounded border border-primary/50 bg-background ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground transition-[background-color,border-color,color,box-shadow]",
      className
    )}
    style={{ transitionDuration: 'var(--motion-base, 180ms)', transitionTimingFunction: 'var(--ease-standard, cubic-bezier(0.2,0,0,1))', ...style }}
    {...props}
  >
    <CheckboxPrimitive.Indicator forceMount className="anim-transition flex items-center justify-center text-current data-[state=checked]:scale-100 data-[state=unchecked]:scale-0 data-[state=checked]:opacity-100 data-[state=unchecked]:opacity-0 transition-[opacity,transform]" style={{ transitionDuration: 'var(--motion-fast, 120ms)', transitionTimingFunction: 'var(--ease-spring, cubic-bezier(0.34,1.56,0.64,1))' }}>
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8l3 3 7-7" />
      </svg>
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
