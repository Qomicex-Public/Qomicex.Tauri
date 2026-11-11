// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { FieldType, InputDecl, OutputDecl } from './types.ts'

function coerceBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true' || value === 'True') return true
  if (value === 0 || value === '0' || value === 'false' || value === 'False') return false
  throw new Error('需要 Bool')
}

export function coerceFieldValue(type: FieldType, value: unknown, label: string): unknown {
  if (value === undefined) throw new Error(`${label} 缺少值`)
  switch (type) {
    case 'String':
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      throw new Error(`${label} 需要 String`)
    case 'Number': {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) throw new Error(`${label} 需要 Number`)
      return number
    }
    case 'Bool':
      try {
        return coerceBool(value)
      } catch {
        throw new Error(`${label} 需要 Bool`)
      }
    case 'DateTime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${label} 需要 DateTime`)
      return value
    case 'Json':
      try {
        JSON.stringify(value)
        return value
      } catch {
        throw new Error(`${label} 需要可序列化 Json`)
      }
    case 'Binary':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 需要 Binary`)
      return value
  }
}

function defaultValue(decl: InputDecl): unknown {
  if (decl.default === undefined) return undefined
  if (decl.type === 'Json' || decl.type === 'Binary') {
    try {
      return JSON.parse(decl.default)
    } catch {
      throw new Error(`Input.${decl.name} 的 Default 不是合法 JSON`)
    }
  }
  return decl.default
}

export function resolveInputValues(decls: InputDecl[], args?: Record<string, unknown>): Record<string, unknown> {
  if (decls.length === 0) return args ?? {}
  const provided = args ?? {}
  for (const key of Object.keys(provided)) {
    if (!decls.some((decl) => decl.name === key)) throw new Error(`未知输入: ${key}`)
  }
  const out: Record<string, unknown> = {}
  for (const decl of decls) {
    const raw = Object.prototype.hasOwnProperty.call(provided, decl.name) ? provided[decl.name] : undefined
    if (raw === undefined && decl.default === undefined) {
      if (decl.required) throw new Error(`缺少必填输入: ${decl.name}`)
      continue
    }
    out[decl.name] = coerceFieldValue(decl.type, raw === undefined ? defaultValue(decl) : raw, `Input.${decl.name}`)
  }
  return out
}

export function resolveOutputValues(
  decls: OutputDecl[],
  resolve: (source: string) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const decl of decls) {
    try {
      out[decl.name] = coerceFieldValue(decl.type, resolve(decl.source), `Output.${decl.name}`)
    } catch {
      out[decl.name] = undefined
    }
  }
  return out
}
