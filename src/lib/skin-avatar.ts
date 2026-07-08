export async function cropHeadFromSkin(skinBlob: Blob, size = 64): Promise<Blob> {
  const bitmap = await createImageBitmap(skinBlob)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(bitmap, 8, 8, 8, 8, 0, 0, size, size)
  ctx.drawImage(bitmap, 40, 8, 8, 8, 0, 0, size, size)
  bitmap.close()
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('canvas.toBlob returned null'))
    }, 'image/png')
  })
}
