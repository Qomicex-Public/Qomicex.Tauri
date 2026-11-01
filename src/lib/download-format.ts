// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 速度值过闸：非有限数（NaN/Infinity）与负数一律归 0。
 * REST 进度响应可能来自没有 speed 字段的旧插件（undefined），SSE 之外的
 * 持久化数据也可能带脏值；轮询、聚合、图表与格式化都应先过这里。
 */
export function normalizeSpeed(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function formatSpeed(bytesPerSec: number): string {
  const v = normalizeSpeed(bytesPerSec)
  if (v <= 0) return ''
  if (v >= 1_073_741_824) return `${(v / 1_073_741_824).toFixed(1)} GB/s`
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} MB/s`
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB/s`
  return `${v.toFixed(0)} B/s`
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return ''
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes.toFixed(0)} B`
}
