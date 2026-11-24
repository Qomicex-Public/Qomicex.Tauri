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

    // 逐块切入：单块约 200ms，块间隔 150ms（约上一块的 75%）保持连贯。
    // 首块 90ms 起步：与侧栏最后几项重叠，避免「内容区先空一拍」。
    const index = el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : 0
    const delay = 90 + Math.min(index, 10) * 150
    const header = el.firstElementChild as HTMLElement | null
    const card = el.lastElementChild as HTMLElement | null
    const rows = card
      ? Array.from(card.children).filter((child): child is HTMLElement => child instanceof HTMLElement).slice(0, 8)
      : []

    const tl = gsap.timeline({ paused: true })
    if (header) {
      gsap.set(header, { y: 6, opacity: 0 })
      tl.fromTo(header,
        { y: 6, opacity: 0 },
        { y: 0, opacity: 1, duration: sec(170, motion), ease: 'power3.out' },
        sec(delay, motion))
    }
    // 卡片面板和行一起淡入：只动行的话，入场期间会先露出一块空的深色卡片（像黑块）
    if (card) {
      gsap.set(card, { opacity: 0 })
      tl.fromTo(card,
        { opacity: 0 },
        { opacity: 1, duration: sec(180, motion), ease: 'power2.out' },
        sec(delay, motion))
    }
    if (rows.length > 0) {
      gsap.set(rows, { y: 8 })
      tl.fromTo(rows,
        { y: 8 },
        {
          y: 0,
          duration: sec(220, motion),
          stagger: sec(8, motion),
          ease: 'power3.out',
          onComplete: () => gsap.set(rows, { clearProps: 'transform' }),
        },
        sec(delay + 30, motion))
    }

    // 首帧先落初始态，等两次 rAF（首帧布局/模糊采样完成）后再播，
    // 避免把挂载时的长帧算进动画第一帧，侧栏导航看起来会卡一下。
    const rafIds: number[] = []
    let cancelled = false
    rafIds.push(requestAnimationFrame(() => {
      rafIds.push(requestAnimationFrame(() => { if (!cancelled) tl.play(0) }))
    }))

    return () => {
      cancelled = true
      rafIds.forEach((id) => cancelAnimationFrame(id))
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
