// 图标生成：从 build/icon-source.png（DSH-扫描弧）解码 → 面积平均降采样 → 输出全套
// build/icon.png(512) / build/icon.ico(256·64·48·32·16) / build/tray.png(16) / build/tray@2x.png(32) / src/assets/icon.png(512)
// 托盘图标必须精确 16/32px：直接塞大图会让 Windows 自行缩放，导致托盘里偏移、发糊
// 不依赖任何原生图像库；PNG 解码与编码均用 zlib 手工实现
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const OUT_DIR = path.join(__dirname, '..', 'build')
const SOURCE = path.join(OUT_DIR, 'icon-source.png')

// ---- PNG 解码（仅支持 8-bit 非隔行的 RGB / RGBA）----
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('不是有效的 PNG 文件')
  let off = 8
  let width = 0
  let height = 0
  let colorType = 0
  let interlace = 1
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (interlace !== 0) throw new Error('不支持的 PNG：隔行扫描')
  const channels = { 2: 3, 6: 4 }[colorType]
  if (!channels) throw new Error('不支持的 PNG 色彩类型：' + colorType + '（仅支持 RGB/RGBA）')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const rowStart = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[rowStart + x - channels] : 0
      const up = y > 0 ? pixels[rowStart - stride + x] : 0
      const ul = y > 0 && x >= channels ? pixels[rowStart - stride + x - channels] : 0
      let val = line[x]
      if (filter === 1) val += left
      else if (filter === 2) val += up
      else if (filter === 3) val += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - ul
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - ul)
        val += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul
      }
      pixels[rowStart + x] = val & 0xff
    }
  }
  if (channels === 3) {
    const rgba = Buffer.alloc(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = pixels[i * 3]
      rgba[i * 4 + 1] = pixels[i * 3 + 1]
      rgba[i * 4 + 2] = pixels[i * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
    return { width, height, pixels: rgba }
  }
  return { width, height, pixels }
}

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
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
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

// ---- 面积平均降采样（预乘 alpha 求均值，透明边缘干净不发黑）----
function resample(src, from, to) {
  const out = Buffer.alloc(to * to * 4)
  const ratio = from / to
  for (let y = 0; y < to; y++) {
    const sy0 = Math.floor(y * ratio)
    const sy1 = Math.min(from, Math.max(sy0 + 1, Math.floor((y + 1) * ratio)))
    for (let x = 0; x < to; x++) {
      const sx0 = Math.floor(x * ratio)
      const sx1 = Math.min(from, Math.max(sx0 + 1, Math.floor((x + 1) * ratio)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * from + sx) * 4
          const w = src[i + 3]
          r += src[i] * w
          g += src[i + 1] * w
          b += src[i + 2] * w
          a += w
          n++
        }
      }
      const o = (y * to + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / n)
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

const source = decodePng(fs.readFileSync(SOURCE))
fs.mkdirSync(OUT_DIR, { recursive: true })
const master = resample(source.pixels, source.width, 512)
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(master, 512))
fs.mkdirSync(path.join(OUT_DIR, '..', 'src', 'assets'), { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, '..', 'src', 'assets', 'icon.png'), encodePng(master, 512))
const sizes = [256, 64, 48, 32, 16]
const entries = sizes.map((size) => ({
  size,
  data: encodePng(resample(source.pixels, source.width, size), size),
}))
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(entries))
fs.writeFileSync(path.join(OUT_DIR, 'tray.png'), encodePng(resample(source.pixels, source.width, 16), 16))
fs.writeFileSync(path.join(OUT_DIR, 'tray@2x.png'), encodePng(resample(source.pixels, source.width, 32), 32))
console.log('[icons] 已从', path.basename(SOURCE), source.width + 'x' + source.height,
  '生成 icon.png / icon.ico / tray.png / tray@2x.png / src/assets/icon.png')
