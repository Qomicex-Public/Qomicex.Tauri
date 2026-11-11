// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BindingMode, BindingSpec, ConverterSpec } from './types.ts'

export interface BindingOptions {
  converters?: ConverterSpec[]
  locale?: string
  targetType?: string
}

function splitArgs(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let quote = ''
  for (const char of raw) {
    if (quote) {
      current += char
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      out.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseMode(value: string | undefined): BindingMode {
  if (value === 'TwoWay' || value === 'OneWayToSource') return value
  return 'OneWay'
}

/** 解析 `{Binding Path, Converter=Name, ConverterParameter='x', Mode=TwoWay}` 或 `{MultiBinding Paths='a|b', ...}`。 */
export function parseBinding(raw: string): BindingSpec | null {
  const text = raw.trim()
  const match = text.match(/^\{\s*(Binding|MultiBinding)\s+([\s\S]*)\}$/)
  if (!match) return null
  const multi = match[1] === 'MultiBinding'
  const args = splitArgs(match[2])
  const values = new Map<string, string>()
  let path: string | undefined
  for (const arg of args) {
    const index = arg.indexOf('=')
    if (index < 0) {
      if (!path) path = arg.trim()
      continue
    }
    values.set(arg.slice(0, index).trim().toLowerCase(), arg.slice(index + 1).trim())
  }
  const pathValue = unquote(values.get('path') ?? path ?? '')
  const pathsValue = values.get('paths')
  if (!multi && !pathValue) return null
  if (multi && !pathsValue && !pathValue) return null
  const paths = multi
    ? unquote(pathsValue ?? pathValue ?? '').split('|').map((item) => item.trim()).filter(Boolean)
    : undefined
  return {
    path: multi ? undefined : pathValue,
    paths,
    converter: values.get('converter') ? unquote(values.get('converter')!) : undefined,
    parameter: values.get('converterparameter') ? unquote(values.get('converterparameter')!) : undefined,
    mode: parseMode(values.get('mode')),
  }
}

export function exactBinding(raw: string): BindingSpec | null {
  const binding = parseBinding(raw)
  if (!binding) return null
  return raw.trim().startsWith('{Binding') || raw.trim().startsWith('{MultiBinding') ? binding : null
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true' || value === 'True') return true
  return false
}

function formatNumber(value: unknown, format: string | undefined, parameter: string | undefined, locale: string): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return asString(value)
  const spec = parameter ?? format
  const digits = spec?.match(/^(?:N|F)?(\d+)$/i)?.[1] ?? spec?.match(/\.(\d+)/)?.[1]
  if (digits) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: Number(digits),
      maximumFractionDigits: Number(digits),
    }).format(number)
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(number)
}

function formatDate(value: unknown, format: string | undefined, locale: string): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return asString(value)
  if (!format) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  const parts: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    dd: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
  }
  return format.replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => parts[token] ?? token)
}

const compiled = new Map<string, (...args: unknown[]) => unknown>()

function runScript(code: string, values: unknown[], parameter: string | undefined, targetType: string, culture: string, scope: Record<string, unknown>): unknown {
  let fn = compiled.get(code)
  if (!fn) {
    fn = new Function('value', 'values', 'parameter', 'targetType', 'culture', 'scope', `"use strict";\n${code}`) as (...args: unknown[]) => unknown
    compiled.set(code, fn)
  }
  return fn(values[0], values, parameter, targetType, culture, scope)
}

function converterOf(options: BindingOptions, name: string | undefined): ConverterSpec | undefined {
  if (!name) return undefined
  return options.converters?.find((converter) => converter.name === name)
}

export function convertValue(
  value: unknown,
  converterName: string | undefined,
  parameter: string | undefined,
  options: BindingOptions,
  scope: Record<string, unknown> = {},
): unknown {
  const converter = converterOf(options, converterName)
  if (!converter) return value
  try {
    switch (converter.type) {
      case 'String':
        return asString(value)
      case 'Number': {
        const number = Number(value)
        return Number.isFinite(number) ? number : undefined
      }
      case 'Bool':
        return parseBool(value)
      case 'DateTime':
        return formatDate(value, parameter ?? converter.format, options.locale ?? 'en-US')
      case 'Json':
        return asString(value)
      case 'Format':
        return formatNumber(value, converter.format, parameter, options.locale ?? 'en-US')
      case 'Map':
        return converter.map?.find((entry) => entry.from === asString(value))?.to ?? value
      case 'BoolToVisibility':
        return parseBool(value) ? 'Visible' : 'Collapsed'
      case 'Upper':
        return asString(value).toUpperCase()
      case 'Lower':
        return asString(value).toLowerCase()
      case 'Join':
        return Array.isArray(value) ? value.map(asString).join(parameter ?? ', ') : asString(value)
      case 'Script':
        return converter.convertScript
          ? runScript(converter.convertScript, [value], parameter, options.targetType ?? '', options.locale ?? 'en-US', scope)
          : value
    }
  } catch (error) {
    console.warn('[widget-converter]', converter.name, error)
    return undefined
  }
  return value
}

export function convertBackValue(
  value: unknown,
  converterName: string | undefined,
  parameter: string | undefined,
  options: BindingOptions,
  scope: Record<string, unknown> = {},
): unknown {
  const converter = converterOf(options, converterName)
  if (!converter) return value
  if (converter.type === 'Script' && converter.convertBackScript) {
    try {
      return runScript(converter.convertBackScript, [value], parameter, options.targetType ?? '', options.locale ?? 'en-US', scope)
    } catch (error) {
      console.warn('[widget-converter]', converter.name, error)
      return undefined
    }
  }
  if (converter.type === 'String') return asString(value)
  if (converter.type === 'Number' || converter.type === 'Format') {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  if (converter.type === 'Bool' || converter.type === 'BoolToVisibility') {
    return converter.type === 'BoolToVisibility' ? value === 'Visible' : parseBool(value)
  }
  if (converter.type === 'Map') {
    return converter.map?.find((entry) => entry.to === asString(value))?.from ?? value
  }
  return value
}

export function convertMultiValue(
  values: unknown[],
  converterName: string | undefined,
  parameter: string | undefined,
  options: BindingOptions,
  scope: Record<string, unknown> = {},
): unknown {
  const converter = converterOf(options, converterName)
  if (!converter) return values
  if (converter.type === 'Join') return values.map(asString).join(parameter ?? ', ')
  if (converter.type === 'Script' && converter.convertScript) {
    try {
      return runScript(converter.convertScript, values, parameter, options.targetType ?? '', options.locale ?? 'en-US', scope)
    } catch (error) {
      console.warn('[widget-converter]', converter.name, error)
      return undefined
    }
  }
  return convertValue(values[0], converterName, parameter, options, scope)
}
