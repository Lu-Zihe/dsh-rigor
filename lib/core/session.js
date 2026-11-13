/**
 * 会话日志读取：DSH 的会话文件是「多帧 zstd」（每个 JSONL 行一个 frame），
 * 单次 zstd decompress 只能拿到第一帧（通常是 200 字节的 session 头），
 * 必须按 magic 切帧逐帧解压。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
export const DEFAULT_SESSIONS_ROOT = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.dsh',
  'sessions',
)

/** 逐帧解压整个 zstd 文件（容忍个别坏帧） */
export function decompressFrames(buf) {
  const offs = []
  let i = 0
  while (true) {
    const j = buf.indexOf(MAGIC, i)
    if (j < 0) break
    offs.push(j)
    i = j + 4
  }
  const chunks = []
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k]
    const e = k + 1 < offs.length ? offs[k + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'))
    } catch {
      // 坏帧跳过，不影响其它行
    }
  }
  return { text: chunks.join(''), frames: offs.length }
}

/** 读取单个会话文件 → records[] */
export function readSessionFile(file) {
  const { text, frames } = decompressFrames(fs.readFileSync(file))
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // 半行/坏行跳过
    }
  }
  return { file, frames, records }
}

/** 递归找会话文件 */
export function listSessionFiles(root = DEFAULT_SESSIONS_ROOT, limit = 200) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= limit) return
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full, depth + 1)
      else if (/\.jsonl\.zstd$/.test(ent.name)) out.push(full)
      if (out.length >= limit) return
    }
  }
  walk(root, 0)
  return out
}
