// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { invoke } from '@tauri-apps/api/core'
import { getSettings } from '../../../api/settings.ts'
import { resolveLocalPath } from './schema.ts'
import type { BinaryValue, ResourceEntry } from './types.ts'
import type { CustomWidgetDef } from './store.ts'

export interface XmlNodeValue {
  Name: string
  Attributes: Record<string, string>
  Text: string
  Children: XmlNodeValue[]
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  json: 'application/json',
  txt: 'text/plain',
  xml: 'application/xml',
}

export function mimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export function base64ToBlobUrl(base64: string, mime: string): string {
  const binary = atob(base64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }))
}

export function makeBinaryValue(base64: string, mime: string, size: number): BinaryValue {
  return { Url: base64ToBlobUrl(base64, mime), Base64: base64, Mime: mime, Size: size }
}

export function parseResourceEntries(
  entries: ResourceEntry[],
  trackUrl: (url: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const entry of entries) {
    try {
      switch (entry.type) {
        case 'String':
          out[entry.name] = entry.value
          break
        case 'Bool':
          out[entry.name] = entry.value === 'True' || entry.value === 'true'
          break
        case 'Number':
          out[entry.name] = Number(entry.value)
          break
        case 'Json':
          out[entry.name] = JSON.parse(entry.value)
          break
        case 'Binary': {
          const mime = entry.mime || 'application/octet-stream'
          const value = makeBinaryValue(entry.value, mime, Math.floor((entry.value.length * 3) / 4))
          trackUrl(value.Url)
          out[entry.name] = value
          break
        }
      }
    } catch {
      out[entry.name] = undefined
    }
  }
  return out
}

export function widgetBaseDir(def: Pick<CustomWidgetDef, 'sourcePath'>): string {
  if (def.sourcePath) {
    const normalized = def.sourcePath.replace(/\\/g, '/')
    const index = normalized.lastIndexOf('/')
    if (index > 0) return normalized.slice(0, index)
  }
  return getSettings().dataDir || '.'
}

export function resolveDataPath(def: Pick<CustomWidgetDef, 'sourcePath'>, path: string): string {
  return resolveLocalPath(path, widgetBaseDir(def))
}

export async function readLocalText(path: string): Promise<string> {
  return invoke<string>('read_widget_data_text', { path })
}

export async function readLocalBinary(path: string): Promise<{ base64: string; size: number }> {
  return invoke<{ base64: string; size: number }>('read_widget_binary', { path })
}

/** XML → 可绑定的树；不执行任何脚本/实体。 */
export function parseXmlValue(text: string): { Root: XmlNodeValue } {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const error = doc.getElementsByTagName('parsererror')[0]
  if (error || !doc.documentElement) {
    throw new Error(error?.textContent?.slice(0, 200) || 'XML 解析失败')
  }
  const convert = (el: Element): XmlNodeValue => {
    const attributes: Record<string, string> = {}
    for (const attribute of Array.from(el.attributes)) attributes[attribute.name] = attribute.value
    const children = Array.from(el.children).map(convert)
    const text = children.length === 0 ? (el.textContent ?? '').trim() : ''
    return { Name: el.tagName, Attributes: attributes, Text: text, Children: children }
  }
  return { Root: convert(doc.documentElement) }
}