// 纯 JS 生成应用图标：渐变方圆 + 闪电 + 状态点 → PNG（512/256/64/32/16）→ ICO
// 不依赖任何原生图像库；PNG 用 zlib.deflateSync 手工封装
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SIZE = 512
const OUT_DIR = path.join(__dirname, '..', 'build')

// ---- PNG 编码（RGBA 8-bit）----
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
function encodePng(pixels, size) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 几何：圆角方圆内的渐变 + 闪电多边形 + 状态点 ----
function lerp(a, b, t) { return a + (b - a) * t }
function gradient(t) {
  // #67E8F9 → #22D3EE → #6366F1 三段
  const stops = [[0x67, 0xe8, 0xf9], [0x22, 0xd3, 0xee], [0x63, 0x66, 0xf1]]
  const scaled = t * 2
  const i = Math.min(1, Math.floor(scaled))
  const f = Math.min(1, scaled - i)
  return [
    Math.round(lerp(stops[i][0], stops[i + 1][0], f)),
    Math.round(lerp(stops[i][1], stops[i + 1][1], f)),
    Math.round(lerp(stops[i][2], stops[i + 1][2], f)),
  ]
}
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r))
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r))
  return dx * dx + dy * dy <= r * r
}
// 闪电轮廓（48 视箱直线多边形，来自 SVG path）
const BOLT = [[26.6, 8.5], [15.2, 25.4], [22.3, 25.4], [20.4, 39.5], [31.8, 22.6], [24.7, 22.6]]
function pointInPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function renderIcon(size) {
  const scale = size / SIZE
  const pad = 40 * scale
  const radius = 140 * scale
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4
      if (inRoundedRect(x, y, pad, pad, size - pad, size - pad, radius)) {
        const [r, g, b] = gradient((y - pad) / (size - pad * 2))
        // 顶部高光渐隐（gloss）
        const gloss = y < size * 0.55 ? 0.5 * (1 - y / (size * 0.55)) : 0
        // 内描边：距边缘 3px 内提亮
        const edge = inRoundedRect(x, y, pad + 5 * scale, pad + 5 * scale, size - pad - 5 * scale, size - pad - 5 * scale, radius - 5 * scale)
        const border = edge ? 0 : 0.38
        pixels[index] = Math.min(255, Math.round(lerp(r, 255, gloss) + border * (255 - r) * 0.3))
        pixels[index + 1] = Math.min(255, Math.round(lerp(g, 255, gloss) + border * (255 - g) * 0.3))
        pixels[index + 2] = Math.min(255, Math.round(lerp(b, 255, gloss) + border * (255 - b) * 0.3))
        pixels[index + 3] = 255
      }
    }
  }
  // 闪电（白色实心，超出圆角矩形区域需裁剪）
  const scaledBolt = BOLT.map(([bx, by]) => [bx * scale, by * scale])
  for (let y = Math.floor(8 * scale); y < Math.floor(40 * scale); y++) {
    for (let x = Math.floor(15 * scale); x < Math.floor(32 * scale); x++) {
      if (!pointInPolygon(x + 0.5, y + 0.5, scaledBolt)) continue
      if (!inRoundedRect(x, y, pad, pad, size - pad, size - pad, radius)) continue
      const index = (y * size + x) * 4
      pixels[index] = 255
      pixels[index + 1] = 255
      pixels[index + 2] = 255
      pixels[index + 3] = 245
    }
  }
  // 状态点：外暗环 + 绿色圆
  const cx = 37.5 * scale
  const cy = 37.5 * scale
  const ringR = 4.4 * scale
  const dotR = 3 * scale
  for (let y = Math.floor(cy - ringR) - 1; y <= cy + ringR + 1; y++) {
    for (let x = Math.floor(cx - ringR) - 1; x <= cx + ringR + 1; x++) {
      if (!inRoundedRect(x, y, pad, pad, size - pad, size - pad, radius)) continue
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const index = (y * size + x) * 4
      if (dist <= dotR) {
        pixels[index] = 0x4a
        pixels[index + 1] = 0xde
        pixels[index + 2] = 0x80
        pixels[index + 3] = 255
      } else if (dist <= ringR) {
        pixels[index] = 0x0b
        pixels[index + 1] = 0x12
        pixels[index + 2] = 0x20
        pixels[index + 3] = 128
      }
    }
  }
  return pixels
}

function downscale(pixels, from, to) {
  const out = Buffer.alloc(to * to * 4)
  const ratio = from / to
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      const sx = Math.min(from - 1, Math.floor((x + 0.5) * ratio))
      const sy = Math.min(from - 1, Math.floor((y + 0.5) * ratio))
      pixels.copy(out, (y * to + x) * 4, (sy * from + sx) * 4, (sy * from + sx) * 4 + 4)
    }
  }
  return out
}

function buildIco(entries) {
  // ICO 头 + 目录 + 各尺寸 PNG（Vista+ 支持 PNG 内嵌）
  const headerSize = 6 + entries.length * 16
  const dir = Buffer.alloc(headerSize)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2) // type icon
  dir.writeUInt16LE(entries.length, 4)
  let offset = headerSize
  entries.forEach((entry, i) => {
    const item = Buffer.alloc(16)
    item[0] = entry.size % 256
    item[1] = entry.size % 256
    item.writeUInt16LE(1, 4) // planes
    item.writeUInt16LE(32, 6) // bpp
    item.writeUInt32LE(entry.data.length, 8)
    item.writeUInt32LE(offset, 12)
    item.copy(dir, 6 + i * 16)
    offset += entry.data.length
  })
  return Buffer.concat([dir, ...entries.map((entry) => entry.data)])
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const master = renderIcon(SIZE)
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(master, SIZE))
fs.mkdirSync(path.join(OUT_DIR, '..', 'src', 'assets'), { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, '..', 'src', 'assets', 'icon.png'), encodePng(master, SIZE))
const sizes = [256, 64, 48, 32, 16]
const entries = sizes.map((size) => ({
  size,
  data: encodePng(size === 256 ? master : downscale(master, SIZE, size), size),
}))
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(entries))
console.log('[icons] build/icon.ico + build/icon.png 已生成')
