import { cn } from '../lib/utils.ts'
import type { CSSProperties } from 'react'

const COLORS: Record<string, string> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
  'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF',
}

const FORMAT_CODES = new Set(['k', 'l', 'm', 'n', 'o', 'r'])

interface MinecraftTextProps {
  text: string | null | undefined
  className?: string
}

export function MinecraftText({ text, className }: MinecraftTextProps) {
  if (!text) return null

  const segments = parseMinecraftCodes(text)
  if (segments.length === 0) return null

  return (
    <span className={cn(className)}>
      {segments.map((seg, i) => (
        <span key={i} style={seg.style}>{seg.text}</span>
      ))}
    </span>
  )
}

function parseMinecraftCodes(input: string): { text: string; style: CSSProperties }[] {
  const parts = input.split(/(§[0-9a-fk-or])/gi)
  const segments: { text: string; style: CSSProperties }[] = []

  let color: string | undefined
  let bold = false
  let italic = false
  let underline = false
  let strikethrough = false

  let buf = ''

  function flush() {
    if (!buf) return
    const style: CSSProperties = {}
    if (color) style.color = color
    if (bold) style.fontWeight = 700
    if (italic) style.fontStyle = 'italic'
    if (underline) style.textDecoration = 'underline'
    if (strikethrough) style.textDecoration = 'line-through'
    if (underline && strikethrough) style.textDecoration = 'underline line-through'
    segments.push({ text: buf, style })
    buf = ''
  }

  for (const part of parts) {
    const m = part.match(/^§([0-9a-fk-or])$/i)
    if (!m) {
      buf += part
      continue
    }
    flush()
    const code = m[1].toLowerCase()
    if (code === 'r') {
      color = undefined
      bold = italic = underline = strikethrough = false
    } else if (FORMAT_CODES.has(code)) {
      if (code === 'l') bold = true
      else if (code === 'o') italic = true
      else if (code === 'n') underline = true
      else if (code === 'm') strikethrough = true
    } else {
      color = COLORS[code]
    }
  }
  flush()

  return segments
}
