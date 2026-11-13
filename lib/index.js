/**
 * dsh-deep-think — DSH 插件入口
 *
 * 分两半：
 *   ① 工具半（host）：注册 deepthink_report 工具，让 Agent 自己就能查"我这轮想得够不够"
 *   ② 提示半（host）：向系统提示注入"深度思考协议"一节（若 API 可用）
 *
 * 设计原则：任何一半失败都不抛错、不阻塞宿主，只降级并记日志。
 * 核心逻辑在 lib/core/*，不依赖宿主 API，可独立用 CLI 跑。
 */
import path from 'node:path'
import { listSessionFiles, readSessionFile } from './core/session.js'
import { analyze, renderReport } from './core/analyze.js'

export const name = 'dsh-deep-think'

export const DEFAULT_CONFIG = {
  /** 注入系统提示 */
  injectPrompt: true,
  /** 注册 deepthink_report 工具 */
  registerTool: true,
  /** 默认分析最近几个会话 */
  defaultLimit: 1,
  /** 急切动手告警阈值（字） */
  thinActingThreshold: 120,
}

const PROMPT_SECTION = `## 深度思考协议（dsh-deep-think）
在调用任何工具之前，先写满五项：①真实问题 ②已知/未知（含来源）③假设清单 ④检索计划 ⑤判据。
输出前自检：每个数字/日期/规范名必须能指出来源，否则标注【未核实】或删除；推断标【推断】。
禁止用文件名、标题、名称推断内容。简洁是输出层要求，不是少查的理由。`

function tryRegisterPrompt(ctx, cfg) {
  if (!cfg.injectPrompt) return
  try {
    const sp = ctx.systemPrompt
    if (sp && typeof sp.section === 'function') {
      sp.section({ id: 'deep-think', order: 900, text: PROMPT_SECTION })
      ctx.logger?.info?.('deep-think: prompt section registered')
    } else {
      ctx.logger?.debug?.('deep-think: ctx.systemPrompt.section 不可用，跳过 prompt 注入')
    }
  } catch (err) {
    ctx.logger?.warn?.(`deep-think: prompt 注入失败: ${err?.message ?? err}`)
  }
}

function buildReportTool(ctx, cfg) {
  return {
    name: 'deepthink_report',
    description:
      '分析本次/最近会话的“深度画像”：动手前推理字数、急切动手率、无源断言率、工具调用数。用于自查是否“想两句就动手”。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: '分析最近几个会话，默认 1' },
        session: { type: 'string', description: '指定会话文件绝对路径（可选）' },
        format: { type: 'string', enum: ['markdown', 'json'], description: '输出格式，默认 markdown' },
      },
    },
    async execute(args = {}) {
      const files = args.session ? [args.session] : listSessionFiles(undefined, 200).slice(0, 200)
      if (!files.length) return { ok: false, error: '没有找到会话文件' }
      const sorted = files
        .map((f) => {
          let mtime = 0
          try {
            mtime = ctx.fs?.statSync?.(f)?.mtimeMs ?? 0
          } catch {}
          return { f, mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, Math.max(1, args.limit || cfg.defaultLimit))
        .map((x) => x.f)

      const results = []
      for (const f of sorted) {
        try {
          const { records, frames } = readSessionFile(f)
          results.push({ file: f, frames, ...analyze(records) })
        } catch {}
      }
      if (!results.length) return { ok: false, error: '会话解析失败' }
      if (args.format === 'json') {
        return { ok: true, data: results.map((r) => ({ file: r.file, summary: r.summary })) }
      }
      return {
        ok: true,
        text: results.map((r) => renderReport(r, { title: path.basename(path.dirname(r.file)) })).join('\n\n---\n\n'),
      }
    },
  }
}

function tryRegisterTool(ctx, cfg) {
  if (!cfg.registerTool) return () => {}
  const tool = buildReportTool(ctx, cfg)
  const candidates = [
    () => ctx.tools?.register?.(tool),
    () => ctx.tools?.define?.(tool),
    () => ctx.tools?.add?.(tool),
    () => ctx.tool?.register?.(tool),
  ]
  for (const fn of candidates) {
    try {
      const ret = fn()
      if (ret !== undefined) {
        ctx.logger?.info?.('deep-think: tool registered (deepthink_report)')
        return () => {
          try {
            ctx.tools?.unregister?.('deepthink_report')
          } catch {}
        }
      }
    } catch {
      // 下一个候选
    }
  }
  ctx.logger?.warn?.('deep-think: 没有匹配到工具注册 API，工具半降级（CLI 仍可用：node lib/cli.js）')
  return () => {}
}

/**
 * @param {any} ctx cordis context
 * @param {typeof DEFAULT_CONFIG} config
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  tryRegisterPrompt(ctx, cfg)
  const disposeTool = tryRegisterTool(ctx, cfg)
  ctx.logger?.info?.('deep-think mounted')
  return () => {
    try {
      disposeTool?.()
    } catch {}
    try {
      ctx.systemPrompt?.removeSection?.('deep-think')
    } catch {}
  }
}
