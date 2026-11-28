/** Shrinks a photo to a JPEG of at most 1600 px, so uploads stay small. The server checks it again. */
export async function resizeImage(file: File, readError: string, prepareError: string): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const maximumSide = 1600
  const scale = Math.min(1, maximumSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new Error(readError)
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(prepareError))),
      'image/jpeg',
      0.85,
    )
  })
}
