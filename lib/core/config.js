/**
 * 运行时配置：让「off / warn / reject」三种模式可以由用户随时切换，
 * 不需要改 profile patch、不需要重启 DSH。
 *
 * 优先级：运行时文件 > profile patch 里的 config > 内置默认
 * 文件路径：~/.dsh/rigor.config.json
 *
 * 读取带 1 秒缓存（每轮会读一次，避免频繁磁盘 IO，又能几乎即时生效）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 支持 RIGOR_HOME 覆盖，便于测试时隔离 */
function dshHome() {
  return process.env.RIGOR_HOME || path.join(os.homedir(), '.dsh')
}
export function configPath() {
  return path.join(dshHome(), 'rigor.config.json')
}
export function violationLogPath() {
  return path.join(dshHome(), 'rigor-violations.log')
}
/** 兼容旧引用 */
export const CONFIG_PATH = configPath()

export const VALID_MODES = ['off', 'warn', 'reject']

let cache = { at: 0, value: null }

/** 读取运行时配置；文件不存在或损坏时返回 {} */
export function readRuntimeConfig({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.value && now - cache.at < 1000) return cache.value
  let value = {}
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') value = parsed
  } catch {
    value = {}
  }
  cache = { at: now, value }
  return value
}

/** 写入运行时配置（浅合并），返回写入后的完整配置 */
export function writeRuntimeConfig(patch) {
  const current = readRuntimeConfig({ force: true })
  const next = { ...current, ...patch }
  if (next.policy && current.policy) next.policy = { ...current.policy, ...patch.policy }
  const target = configPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n', 'utf8')
  cache = { at: 0, value: null }
  return next
}

/** 设置模式：只接受 off / warn / reject */
export function setMode(mode) {
  const m = String(mode || '').trim().toLowerCase()
  if (!VALID_MODES.includes(m)) {
    throw new Error(`mode 只能是 ${VALID_MODES.join(' / ')}，收到 "${mode}"`)
  }
  writeRuntimeConfig({ policy: { mode: m }, mode: m, updatedAt: new Date().toISOString() })
  return m
}

/** 当前生效模式（运行时 > 默认） */
export function currentMode(fallback = 'off') {
  const cfg = readRuntimeConfig()
  const m = cfg?.policy?.mode ?? cfg?.mode
  return VALID_MODES.includes(m) ? m : fallback
}

export const VIOLATION_LOG = violationLogPath()

/** warn 模式下的记账：不合格的回答记一行，不打断会话 */
export function appendViolation(entry) {
  try {
    const line = `${new Date().toISOString()} | turn=${entry.turn ?? '-'} | ${entry.summary}\n`
    const log = violationLogPath()
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.appendFileSync(log, line, 'utf8')
  } catch {}
}

/** 读最近 N 条记账 */
export function recentViolations(n = 5) {
  try {
    return fs.readFileSync(violationLogPath(), 'utf8').trim().split('\n').filter(Boolean).slice(-n)
  } catch {
    return []
  }
}
