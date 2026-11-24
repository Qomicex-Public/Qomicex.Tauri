// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import gsap from 'gsap'
import { readMotion, sec } from '../../lib/motion.ts'
import { cn } from '../../lib/utils.ts'

export function SettingSection({ title, icon, children, action, id }: { title: string; icon?: ReactNode; children: ReactNode; action?: ReactNode; id?: string }) {
  const ref = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const motion = readMotion()
    if (!motion.enabled) return

    // 逐块切入：同一容器内按 DOM 顺序错开 45ms；只动标题和卡片内的行，
    // 卡片本身（玻璃）不动，避免打断 backdrop 采样。
    const index = el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : 0
    const delay = Math.min(index, 10) * 45
    const header = el.firstElementChild as HTMLElement | null
    const card = el.lastElementChild as HTMLElement | null
    const rows = card
      ? Array.from(card.children).filter((child): child is HTMLElement => child instanceof HTMLElement).slice(0, 12)
      : []

    const tl = gsap.timeline()
    if (header) {
      tl.fromTo(header,
        { y: 8, opacity: 0 },
        { y: 0, opacity: 1, duration: sec(220, motion), ease: 'power3.out' },
        sec(delay, motion))
    }
    // 卡片面板和行一起淡入：只动行的话，入场期间会先露出一块空的深色卡片（像黑块）
    if (card) {
      tl.fromTo(card,
        { opacity: 0 },
        { opacity: 1, duration: sec(200, motion), ease: 'power2.out' },
        sec(delay, motion))
    }
    if (rows.length > 0) {
      tl.fromTo(rows,
        { y: 10 },
        {
          y: 0,
          duration: sec(280, motion),
          stagger: sec(14, motion),
          ease: 'power3.out',
          onComplete: () => gsap.set(rows, { clearProps: 'transform' }),
        },
        sec(delay + 40, motion))
    }

    return () => {
      tl.kill()
      if (header) gsap.set(header, { clearProps: 'transform,opacity' })
      if (card) gsap.set(card, { clearProps: 'opacity' })
      gsap.set(rows, { clearProps: 'transform' })
    }
  }, [])

  return (
    <section ref={ref} id={id} data-setting-section className="space-y-1">
      <div className="flex items-center gap-2 px-1 pb-2 pt-1">
        {icon && <span className="text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
        <h3 className="flex-1 text-sm font-semibold text-foreground/90">{title}</h3>
        {action && <div className="flex shrink-0 items-center">{action}</div>}
      </div>
      <div className="glass-surface divide-y divide-border/60 rounded-xl border border-border/60 bg-card/40">
        {children}
      </div>
    </section>
  )
}

export function SettingRow({ label, description, control, onClick, className }: {
  label: string
  description?: string
  control?: ReactNode
  onClick?: () => void
  className?: string
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-4 px-4 py-3 text-left',
        onClick && 'cursor-pointer transition-colors hover:bg-accent/50',
        className
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{description}</div>}
      </div>
      {control && <div className="flex shrink-0 items-center">{control}</div>}
    </Comp>
  )
}
