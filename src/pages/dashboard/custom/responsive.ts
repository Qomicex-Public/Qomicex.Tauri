// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { WidgetSizeInfo } from './types.ts'

type Field = keyof WidgetSizeInfo
type Operator = '<' | '<=' | '>' | '>=' | '==' | '!='

interface Term {
  field: Field
  operator: Operator
  value: number
}

const TERM = /^(?:Size\.)?(Width|Height|PixelWidth|PixelHeight)\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)$/i
const FIELDS: Record<string, Field> = {
  width: 'Width',
  height: 'Height',
  pixelwidth: 'PixelWidth',
  pixelheight: 'PixelHeight',
}

function parseTerm(raw: string): Term {
  const match = raw.trim().match(TERM)
  if (!match) throw new Error(`无效尺寸条件: ${raw}`)
  return {
    field: FIELDS[match[1].toLowerCase()],
    operator: match[2] as Operator,
    value: Number(match[3]),
  }
}

function parseWhen(raw: string): { terms: Term[]; joiners: Array<'and' | 'or'> } {
  const body = raw.trim()
  if (!body) throw new Error('When 不能为空')
  const parts = body.split(/\s+(and|or)\s+/i)
  const terms: Term[] = []
  const joiners: Array<'and' | 'or'> = []
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 0) terms.push(parseTerm(parts[index]))
    else joiners.push(parts[index].toLowerCase() as 'and' | 'or')
  }
  return { terms, joiners }
}

export function validateWhen(raw: string): string {
  parseWhen(raw)
  return raw.trim()
}

function compare(left: number, operator: Operator, right: number): boolean {
  switch (operator) {
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    case '>=':
      return left >= right
    case '==':
      return left === right
    case '!=':
      return left !== right
  }
}

export function evaluateWhen(raw: string, size: WidgetSizeInfo): boolean {
  let terms: Term[]
  let joiners: Array<'and' | 'or'>
  try {
    ({ terms, joiners } = parseWhen(raw))
  } catch {
    return false
  }
  if (terms.length === 0) return false
  let result = compare(size[terms[0].field], terms[0].operator, terms[0].value)
  for (let index = 0; index < joiners.length; index += 1) {
    const next = compare(size[terms[index + 1].field], terms[index + 1].operator, terms[index + 1].value)
    result = joiners[index] === 'and' ? result && next : result || next
  }
  return result
}
