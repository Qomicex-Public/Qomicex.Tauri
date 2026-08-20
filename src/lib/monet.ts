// 莫奈式（Material You 风格）背景主色提取 —— 实用型实现。
//
// 不做完整 HCT/CAM16 色调板，而是：
//   1. 背景图以 fetch→blob 方式取回（后端 CORS 宽松，blob URL 与页面同源，画布不会污染）；
//   2. 缩放绘制到 ≤48×48 网格获得像素采样；
//   3. 按色相分桶、以饱和度加权累积颜色，选出“最有彩色感”的主导桶；
//   4. 对该桶均色提饱和、把明度钳到适合作为强调色的区间，输出 hex。
// 无背景 / 图片加载失败 / 画面过于灰暗（没有可用的彩色桶）时返回 null，由调用方回退默认主题色。

const MAX_SIDE = 48
/** 色相分桶数（每桶 360/24 = 15°）。 */
const BUCKETS = 24
/** 低于该饱和度视为“灰”，不计入彩色候选。 */
const MIN_SAT = 0.12
/** 主导桶平均饱和度低于该值视为画面太灰，无法取色。 */
const MIN_DOMINANT_SAT = 0.3

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('load failed'))
    img.src = url
  })
}

/** 取回图片（转 blob，规避跨源 canvas 污染）并绘到小画布采样。返回像素数组 [-1 为失败]。 */
async function samplePixels(url: string): Promise<{ r: number; g: number; b: number; a: number }[] | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    try {
      const img = await loadImage(objectUrl)
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.max(1, Math.round(img.naturalWidth * scale))
      const h = Math.max(1, Math.round(img.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(img, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h).data
      const out: { r: number; g: number; b: number; a: number }[] = []
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255
        if (a <= 0.05) continue
        out.push({ r: data[i], g: data[i + 1], b: data[i + 2], a })
      }
      return out
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch {
    return null
  }
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60; break
      case gn: h = ((bn - rn) / d + 2) * 60; break
      default: h = ((rn - gn) / d + 4) * 60
    }
  }
  return { h: (h + 360) % 360, s, l }
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** 从像素采样中挑出主导“有彩色”主色；无法取到则返回 null。 */
function pickAccent(pixels: { r: number; g: number; b: number; a: number }[]): string | null {
  if (!pixels.length) return null
  // 色相桶：按饱和度加权累积 RGB。
  const sumR = new Array<number>(BUCKETS).fill(0)
  const sumG = new Array<number>(BUCKETS).fill(0)
  const sumB = new Array<number>(BUCKETS).fill(0)
  const weight = new Array<number>(BUCKETS).fill(0)

  for (const p of pixels) {
    const { h, s } = rgbToHsl(p.r, p.g, p.b)
    if (s < MIN_SAT) continue
    const bIdx = Math.min(BUCKETS - 1, Math.floor(h / 360 * BUCKETS))
    const w = s * p.a // 透明度也参与权重
    sumR[bIdx] += p.r * w
    sumG[bIdx] += p.g * w
    sumB[bIdx] += p.b * w
    weight[bIdx] += w
  }

  // 选 score 最高的桶：权重 ^0.5 × 平均饱和度（偏好面积较大且色彩较纯的）。
  let best = -1
  let bestScore = -1
  for (let i = 0; i < BUCKETS; i++) {
    if (weight[i] <= 0) continue
    const r = sumR[i] / weight[i]
    const g = sumG[i] / weight[i]
    const b = sumB[i] / weight[i]
    const { s } = rgbToHsl(r, g, b)
    const score = Math.pow(weight[i], 0.5) * s
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best < 0) return null

  const r = sumR[best] / weight[best]
  const g = sumG[best] / weight[best]
  const b = sumB[best] / weight[best]
  const { h, s, l } = rgbToHsl(r, g, b)
  if (s < MIN_DOMINANT_SAT) return null

  // 调成适合做强调色的主色：保证足够饱和，明度钳到兼顾深浅主题的区间。
  const outS = Math.min(0.9, Math.max(0.5, s * 1.25))
  const outL = Math.min(0.55, Math.max(0.4, l))
  return hslToHex(h, outS, outL)
}

/** 从背景图 URL 提取一个可作为主题强调色的 hex；失败返回 null。 */
export async function extractAccentFromImageUrl(url: string): Promise<string | null> {
  const pixels = await samplePixels(url)
  if (!pixels) return null
  return pickAccent(pixels)
}
