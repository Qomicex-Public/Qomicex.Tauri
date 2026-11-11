// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { interpolateDeep } from '../schema.ts'
import type { ActionSpec, FunctionNode, StructDef, WidgetSizeInfo } from '../types.ts'
import type { ScriptSandbox } from './sandbox.ts'

export interface FunctionContext {
  inputs: Record<string, unknown>
  resources: Record<string, unknown>
  data: Record<string, unknown>
  results: Record<string, unknown>
  scope: Record<string, unknown>
  size?: WidgetSizeInfo
}

function structByName(fn: FunctionNode, name: string): StructDef | undefined {
  return fn.structs.find((item) => item.name === name)
}

/** 从 Inputs 按 Struct 字段组装 Input；字段名先精确匹配，再忽略大小写。 */
export function buildInputFromInputs(fn: FunctionNode, inputs: Record<string, unknown>): Record<string, unknown> {
  const input = fn.inputs[0]
  if (!input) return {}
  const struct = structByName(fn, input.type)
  if (!struct) return {}
  const out: Record<string, unknown> = {}
  for (const field of struct.fields) {
    if (Object.prototype.hasOwnProperty.call(inputs, field.name)) {
      out[field.name] = inputs[field.name]
      continue
    }
    const key = Object.keys(inputs).find((item) => item.toLowerCase() === field.name.toLowerCase())
    out[field.name] = key ? inputs[key] : undefined
  }
  return out
}

export function parseArguments(raw: string | undefined, scope: Record<string, unknown>): unknown {
  if (!raw?.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const wrapped = new Error(`Arguments 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
    ;(wrapped as { cause?: unknown }).cause = error
    throw wrapped
  }
  return interpolateDeep(parsed, scope)
}

export function actionArguments(action: ActionSpec | undefined, scope: Record<string, unknown>): unknown {
  if (!action) return undefined
  return parseArguments(action.args.Arguments, scope)
}

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  String: (value) => typeof value === 'string',
  Number: (value) => typeof value === 'number' && Number.isFinite(value),
  Bool: (value) => typeof value === 'boolean',
  DateTime: (value) => typeof value === 'string' || value instanceof Date,
  Json: () => true,
  Binary: (value) => typeof value === 'string' || (!!value && typeof value === 'object'),
}

export function validateOutputs(fn: FunctionNode, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('脚本必须返回对象')
  }
  const record = value as Record<string, unknown>
  for (const output of fn.outputs) {
    if (!Object.prototype.hasOwnProperty.call(record, output.name)) {
      throw new Error(`脚本缺少输出 ${output.name}`)
    }
    const check = TYPE_CHECKS[output.type]
    if (check && !check(record[output.name])) {
      throw new Error(`输出 ${output.name} 类型应为 ${output.type}`)
    }
  }
  return record
}

export async function runFunction(
  fn: FunctionNode,
  action: ActionSpec | undefined,
  sandbox: ScriptSandbox,
  ctx: FunctionContext,
): Promise<Record<string, unknown>> {
  const explicit = actionArguments(action, ctx.scope)
  const input = explicit !== undefined ? explicit : buildInputFromInputs(fn, ctx.inputs)
  const { transpileScript } = await import('./transpile.ts')
  const code = transpileScript(fn.script)
  const result = await sandbox.run(code, {
    Input: input,
    Inputs: ctx.inputs,
    Resources: ctx.resources,
    Data: ctx.data,
    Results: ctx.results,
    Size: ctx.size ?? (ctx.scope.Size as WidgetSizeInfo | undefined) ?? { Width: 0, Height: 0, PixelWidth: 0, PixelHeight: 0 },
  }, Math.min(Math.max(fn.timeout, 100), 10000))
  if (!result.ok) throw new Error(result.error || '脚本执行失败')
  return validateOutputs(fn, result.value)
}
