export type QrOverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type QrOverlayFrame = 'none' | 'white'

export interface QrOverlayLayout {
  frameX: number
  frameY: number
  frameSize: number
  framePadding: number
  qrX: number
  qrY: number
  qrSize: number
}

export function computeQrOverlayLayout(
  width: number,
  height: number,
  position: QrOverlayPosition,
  requestedPercent = 18,
  frame: QrOverlayFrame = 'none',
): QrOverlayLayout {
  const safeWidth = Math.max(1, Math.floor(width))
  const safeHeight = Math.max(1, Math.floor(height))
  const percent = Math.max(12, Math.min(30, requestedPercent))
  const shortSide = Math.min(safeWidth, safeHeight)
  const qrSize = Math.max(96, Math.min(Math.round(shortSide * percent / 100), shortSide - 24))
  const framePadding = frame === 'white' ? Math.max(8, Math.round(qrSize * 0.06)) : 0
  const frameSize = qrSize + framePadding * 2
  const margin = Math.max(16, Math.round(shortSide * 0.035))
  const right = position.endsWith('right')
  const bottom = position.startsWith('bottom')
  const frameX = right
    ? Math.max(0, safeWidth - margin - frameSize)
    : Math.min(margin, Math.max(0, safeWidth - frameSize))
  const frameY = bottom
    ? Math.max(0, safeHeight - margin - frameSize)
    : Math.min(margin, Math.max(0, safeHeight - frameSize))
  return {
    frameX,
    frameY,
    frameSize,
    framePadding,
    qrX: frameX + framePadding,
    qrY: frameY + framePadding,
    qrSize,
  }
}

function loadImage(dataUrl: string, label: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`${label}无法读取，请重新选择 PNG/JPG/WebP`))
    image.src = dataUrl
  })
}

function canvasPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('无法导出叠加二维码后的图片'))
        return
      }
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('无法读取叠加二维码后的图片'))
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('无法读取叠加二维码后的图片'))
          return
        }
        resolve(reader.result)
      }
      reader.readAsDataURL(blob)
    }, 'image/png')
  })
}

/**
 * 二维码永远在 AI 生成/编辑之后由本机叠加。不把二维码交给图片模型重绘，
 * 关闭缩放插值并保留二维码原图自带的静区。默认不额外绘制白色外框；
 * 只有用户明确要求白底、白框或贴纸效果时才增加。
 */
export async function overlayQrDataUrl(
  baseDataUrl: string,
  qrDataUrl: string,
  position: QrOverlayPosition,
  sizePercent = 18,
  frame: QrOverlayFrame = 'none',
): Promise<{ dataUrl: string; width: number; height: number }> {
  const [base, qr] = await Promise.all([
    loadImage(baseDataUrl, '底图'),
    loadImage(qrDataUrl, '二维码'),
  ])
  if (!base.naturalWidth || !base.naturalHeight || !qr.naturalWidth || !qr.naturalHeight) {
    throw new Error('底图或二维码尺寸异常')
  }
  const canvas = document.body.createEl('canvas')
  canvas.hidden = true
  try {
    canvas.width = base.naturalWidth
    canvas.height = base.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前 Obsidian 环境无法处理图片')
    context.drawImage(base, 0, 0)
    const layout = computeQrOverlayLayout(canvas.width, canvas.height, position, sizePercent, frame)
    if (layout.framePadding > 0) {
      context.fillStyle = '#ffffff'
      context.fillRect(layout.frameX, layout.frameY, layout.frameSize, layout.frameSize)
    }
    context.imageSmoothingEnabled = false
    context.drawImage(qr, layout.qrX, layout.qrY, layout.qrSize, layout.qrSize)
    return {
      dataUrl: await canvasPngDataUrl(canvas),
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    canvas.remove()
  }
}

export function closestQrOverlayRatio(width: number, height: number): '2.35:1' | '16:9' | '3:4' | '1:1' {
  const actual = width / Math.max(1, height)
  const candidates = [
    ['2.35:1', 2.35],
    ['16:9', 16 / 9],
    ['3:4', 3 / 4],
    ['1:1', 1],
  ] as const
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate[1] - actual) < Math.abs(best[1] - actual) ? candidate : best,
  )[0]
}
