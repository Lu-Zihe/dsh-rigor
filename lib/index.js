/**
 * dsh-deep-think — DSH 插件入口（v0.2 拦截版）
 *
 * 三件已确认的宿主 API（2026-11-13 从 app.asar 实测，非猜测）：
 *   1. `ctx.on("agent/pre-step", async ({agent, messages, step, signal}, next) => …)`  —— 步骤中间件，有 next()
 *   2. agent 上有 `inject(input)` / `steer(input)` / `followup(input)`：
 *        send(message, target, wakeup) → target ∈ {"next-turn","next-step"}
 *        inject = send(msg,"next-step",false)；steer = send(msg,"next-step",true)
 *   3. `agent.inbox.splice(target, start, removedCount, [msg])` / `.prepend` / `.remove`
 *
 * 因此可以做到「打回重做」：往 next-step 插一条驳回指令，turn 就不会结束，模型必须重答。
 * ⚠️ 做不到「阻止输出」：宿主没有 output guard，回答已经 append 到会话，
 *    所以本质是**驳回+重做**，不是**拦下不让显示**。
 *
 * ⚠️ 本半**未在真实宿主验证**：API 名与调用形态来自代码阅读，事件名（turn-stopping / pre-step）
 *    做了多候选注册 + 全失败降级，最坏情况是插件挂上但不生效，CLI 半不受影响。
 */
import path from 'node:path'
import { listSessionFiles, readSessionFile } from './core/session.js'
import { analyze, renderReport } from './core/analyze.js'
import {
  DEFAULT_POLICY,
  evaluateTurn,
  buildRejectionMessage,
  buildInjectedMessage,
} from './core/intercept.js'

export const name = 'dsh-deep-think'

export const DEFAULT_CONFIG = {
  injectPrompt: true,
  registerTool: true,
  defaultLimit: 1,
  thinActingThreshold: 120,
  /** 拦截策略；mode: 'reject' 才真的打回 */
  policy: DEFAULT_POLICY,
}

const PROMPT_SECTION = `## 深度思考协议（dsh-deep-think）
在调用任何工具之前，先写满五项：①真实问题 ②已知/未知（含来源）③假设清单 ④检索计划 ⑤判据。
输出前自检：每个数字/日期/规范名必须能指出来源，否则标注【未核实】或删除；推断标【推断】。
禁止用文件名、标题、名称推断内容。简洁是输出层要求，不是少查的理由。
本协议由插件在 turn 结束前机器校验：无检索却给数字、或无源断言超阈值，会被注入驳回指令强制重做。`

/** 依次尝试多个事件名，返回解绑函数列表 */
function onAny(ctx, names, handler) {
  const offs = []
  for (const n of names) {
    try {
      if (typeof ctx.on !== 'function') break
      const off = ctx.on(n, handler)
      if (typeof off === 'function') offs.push(off)
      else offs.push(() => {})
    } catch {
      // 该事件名不支持，继续下一个
    }
  }
  return offs
}

/** 尝试把消息塞进 agent 的下一步 */
function injectIntoAgent(agent, message) {
  const attempts = [
    () => agent.inject?.(message),
    () => agent.steer?.(message),
    () => agent.followup?.(message),
    () => agent.inbox?.splice?.('next-step', Number.POSITIVE_INFINITY, 0, [message]),
    () => agent.inbox?.prepend?.('next-step', message),
  ]
  for (const fn of attempts) {
    try {
      const ret = fn()
      if (ret !== undefined) return true
    } catch {
      // 下一个候选
    }
  }
  return false
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config, policy: { ...DEFAULT_POLICY, ...(config.policy || {}) } }
  const disposers = []

  // ---------- 1. prompt 注入 ----------
  if (cfg.injectPrompt) {
    try {
      if (typeof ctx.systemPrompt?.section === 'function') {
        ctx.systemPrompt.section({ id: 'deep-think', order: 900, text: PROMPT_SECTION })
        ctx.logger?.info?.('deep-think: prompt section registered')
      }
    } catch (err) {
      ctx.logger?.warn?.(`deep-think: prompt 注入失败: ${err?.message ?? err}`)
    }
  }

  // ---------- 2. 工具注册 ----------
  if (cfg.registerTool) {
    const tool = {
      name: 'deepthink_report',
      description:
        '分析本次/最近会话的“深度画像”：动手前推理字数、急切动手率、无源断言率。用于自查是否“想两句就动手”。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', description: '分析最近几个会话，默认 1' },
          format: { type: 'string', enum: ['markdown', 'json'] },
        },
      },
      async execute(args = {}) {
        const files = listSessionFiles(undefined, 200)
        const picked = files.slice(-Math.max(1, args.limit || cfg.defaultLimit))
        const results = []
        for (const f of picked) {
          try {
            const { records, frames } = readSessionFile(f)
            results.push({ file: f, frames, ...analyze(records, { thinActingThreshold: cfg.thinActingThreshold }) })
          } catch {}
        }
        if (!results.length) return { ok: false, error: '没有可解析的会话' }
        if (args.format === 'json') return { ok: true, data: results.map((r) => ({ file: r.file, summary: r.summary })) }
        return {
          ok: true,
          text: results.map((r) => renderReport(r, { title: path.basename(path.dirname(r.file)) })).join('\n\n---\n\n'),
        }
      },
    }
    let mounted = false
    for (const fn of [
      () => ctx.tools?.register?.(tool),
      () => ctx.tools?.define?.(tool),
      () => ctx.tools?.add?.(tool),
    ]) {
      try {
        if (fn() !== undefined) {
          mounted = true
          break
        }
      } catch {}
    }
    ctx.logger?.[mounted ? 'info' : 'warn']?.(
      mounted ? 'deep-think: tool registered' : 'deep-think: 工具注册 API 未命中（CLI 仍可用）',
    )
  }

  // ---------- 3. 拦截：累积每轮状态 ----------
  /** key → { turn, answerText, toolCalls, rejections } */
  const states = new Map()
  const st = (key) => {
    if (!states.has(key)) states.set(key, { turn: null, answerText: '', toolCalls: 0, rejections: 0 })
    return states.get(key)
  }
  const keyOf = (agent, session) => agent?.id ?? session?.id ?? 'default'

  disposers.push(
    ...onAny(ctx, ['session/event'], (session, event) => {
      if (!event || !event.type) return
      const s = st(keyOf(null, session))
      if (event.type === 'turn/start') {
        s.turn = event.data?.turn ?? null
        s.answerText = ''
        s.toolCalls = 0
        s.rejections = 0
      } else if (event.type === 'tool/call') {
        s.toolCalls += 1
      } else if (event.type === 'assistant/message') {
        const content = event.data?.message?.content
        if (Array.isArray(content)) {
          for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') s.answerText += b.text
        }
      }
    }),
  )

  // ---------- 4. 拦截：turn 将结束时评估 + 驳回 ----------
  const handleTurnEnding = async (payload) => {
    const { agent, session } = payload || {}
    const s = st(keyOf(agent, session))
    if (!s.answerText) return
    const verdict = evaluateTurn(
      { answerText: s.answerText, toolCalls: s.toolCalls, rejections: s.rejections },
      cfg.policy,
    )
    if (verdict.ok || verdict.action === 'pass') return
    if (verdict.action === 'give_up') {
      ctx.logger?.warn?.(`deep-think: 已达驳回上限，放行。violations=${verdict.violations.length}`)
      return
    }
    const msg = buildInjectedMessage(
      buildRejectionMessage(verdict.violations, s.rejections + 1),
      s.rejections + 1,
    )
    const injected = agent ? injectIntoAgent(agent, msg) : false
    if (injected) {
      s.rejections += 1
      s.answerText = '' // 清空，等待重做的回答
      s.toolCalls = 0
      ctx.logger?.info?.(`deep-think: 驳回第 ${s.rejections} 次（${verdict.violations.length} 项违规）`)
    } else {
      ctx.logger?.warn?.('deep-think: 无法注入驳回消息（host API 不匹配），本次只记账')
    }
  }

  disposers.push(
    ...onAny(ctx, ['agent/turn-stopping', 'agent/pre-turn-end', 'agent/turn-ending'], handleTurnEnding),
  )

  ctx.logger?.info?.('deep-think mounted (v0.2 intercept)')

  return () => {
    for (const off of disposers) {
      try {
        off?.()
      } catch {}
    }
    try {
      ctx.systemPrompt?.removeSection?.('deep-think')
    } catch {}
  }
}
