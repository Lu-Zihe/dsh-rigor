#!/usr/bin/env node
/**
 * deep-think CLI
 *
 *   deep-think                       # 分析最近一个会话
 *   deep-think --session <file>      # 指定会话文件
 *   deep-think --root <dir> --limit 5 # 分析最近 5 个会话并汇总
 *   deep-think --json                # 输出 JSON（给脚本/看板用）
 *   deep-think --out report.md       # 落盘
 */
import fs from 'node:fs'
import path from 'node:path'
import { listSessionFiles, readSessionFile, DEFAULT_SESSIONS_ROOT } from './core/session.js'
import { analyze, renderReport } from './core/analyze.js'
import { readRuntimeConfig, setMode, currentMode, CONFIG_PATH, VALID_MODES, recentViolations, VIOLATION_LOG } from './core/config.js'

function ensureParent(file) {
  const dir = path.dirname(path.resolve(file))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function writeOut(file, text) {
  ensureParent(file)
  fs.writeFileSync(file, text, 'utf8')
}

function parseArgs(argv) {
  const a = {
    root: DEFAULT_SESSIONS_ROOT,
    limit: 1,
    json: false,
    out: null,
    session: null,
    title: null,
    mode: null,
    status: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--root') (a.root = v), i++
    else if (k === '--session') (a.session = v), i++
    else if (k === '--limit') (a.limit = Math.max(1, parseInt(v, 10) || 1)), i++
    else if (k === '--out') (a.out = v), i++
    else if (k === '--title') (a.title = v), i++
    else if (k === '--mode') (a.mode = v), i++
    else if (k === '--status') a.status = true
    else if (k === '--json') a.json = true
    else if (k === '--help' || k === '-h') a.help = true
  }
  return a
}

function pickSessions(args) {
  if (args.session) return [args.session]
  const files = listSessionFiles(args.root)
  const scored = files
    .map((f) => ({ f, mtime: (() => { try { return fs.statSync(f).mtimeMs } catch { return 0 } })() }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, args.limit)
    .map((x) => x.f)
  return scored
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n').slice(0, 40).join('\n'))
    return
  }

  // 模式管理：改 ~/.dsh/deep-think.config.json，无需重启 DSH
  if (args.mode) {
    try {
      const m = setMode(args.mode)
      console.log(`已切换拦截模式 → ${m}`)
      console.log(`配置文件：${CONFIG_PATH}`)
      if (m === 'reject') {
        console.log('注意：reject 会在回答不合格时注入驳回并延长本轮。已内置每轮最多 1 次、总量 3 次熔断。')
      }
      return
    } catch (err) {
      console.error(String(err?.message ?? err))
      console.error(`可选值：${VALID_MODES.join(' / ')}`)
      process.exit(4)
    }
  }
  if (args.status) {
    const cfg = readRuntimeConfig({ force: true })
    console.log(`当前模式：${currentMode('off')}`)
    console.log(`配置文件：${CONFIG_PATH}`)
    console.log(`内容：${JSON.stringify(cfg)}`)
    const recent = recentViolations(10)
    console.log(`\n最近记账（warn 模式才会写，来自 ${VIOLATION_LOG}）：${recent.length ? '' : '（空）'}`)
    for (const line of recent) console.log('  ' + line)
    return
  }

  const files = pickSessions(args)
  if (!files.length) {
    console.error(`没有找到会话文件（root=${args.root}）`)
    process.exit(2)
  }

  const results = []
  for (const f of files) {
    try {
      const { records, frames } = readSessionFile(f)
      const res = analyze(records)
      results.push({ file: f, frames, ...res })
    } catch (err) {
      console.error(`跳过 ${f}: ${err.message}`)
    }
  }
  if (!results.length) {
    console.error('全部解析失败')
    process.exit(3)
  }

  if (args.json) {
    const payload = results.map((r) => ({
      file: r.file,
      frames: r.frames,
      summary: r.summary,
      turns: r.turns.map((t) => ({
        turn: t.turn,
        thinkingBeforeActing: t.thinkingBeforeActing,
        reasoningChars: t.reasoningChars,
        toolCalls: t.toolCalls,
        answerChars: t.answerChars,
        unsourced: t.unsourced,
        user: t.userText.slice(0, 80),
      })),
    }))
    const text = JSON.stringify(payload, null, 2)
    if (args.out) writeOut(args.out, text)
    else console.log(text)
    return
  }

  const md = results
    .map((r, i) =>
      renderReport(r, {
        title: args.title || `${i === 0 ? '' : `会话 ${i + 1} · `}${path.basename(path.dirname(r.file))}`,
      }),
    )
    .join('\n\n---\n\n')

  if (args.out) {
    writeOut(args.out, md)
    console.log(`已写入 ${args.out}`)
  } else {
    console.log(md)
  }
}

main()
