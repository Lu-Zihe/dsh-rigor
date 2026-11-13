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

function ensureParent(file) {
  const dir = path.dirname(path.resolve(file))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function writeOut(file, text) {
  ensureParent(file)
  fs.writeFileSync(file, text, 'utf8')
}

function parseArgs(argv) {
  const a = { root: DEFAULT_SESSIONS_ROOT, limit: 1, json: false, out: null, session: null, title: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--root') (a.root = v), i++
    else if (k === '--session') (a.session = v), i++
    else if (k === '--limit') (a.limit = Math.max(1, parseInt(v, 10) || 1)), i++
    else if (k === '--out') (a.out = v), i++
    else if (k === '--title') (a.title = v), i++
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
