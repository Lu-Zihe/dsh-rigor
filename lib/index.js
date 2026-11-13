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
import { analyze, renderReport } from './core/analyze.js'
import {
  DEFAULT_POLICY,
  evaluateTurn,
  buildRejectionMessage,
  buildInjectedMessage,
} from './core/intercept.js'

// ⚠️ 不在顶层 import core/session.js —— 它依赖 node:fs。
// 插件的 host 半可能跑在 vm 沙箱里，fs 若被禁，静态 import 会在「加载阶段」抛错，
// 有把宿主一起拖下水的风险。改成用到时才动态 import，失败只影响这个工具本身。
async function loadSession() {
  return await import('./core/session.js')
}

export const name = 'dsh-deep-think'

/**
 * 必须声明要用的服务，宿主才会把它们挂到 ctx 上。
 * 实测（2026-11-13）：不声明时 apply 收到的 ctx 只有一个自有键 `fiber`，
 * ctx.tools / ctx.systemPrompt 全是 undefined —— 工具因此从未注册成功。
 * （ctx.on 是原型方法，不需要注入，所以拦截钩子当初反而能跑。）
 * 参考已装插件：vision-toolkit = ['tools','credentials',...]；auto-memory = ['webServer','tools','systemPrompt',...]。
 */
export const inject = ['tools', 'systemPrompt']

export const DEFAULT_CONFIG = {
  injectPrompt: true,
  registerTool: true,
  defaultLimit: 1,
  thinActingThreshold: 120,
  /**
   * 拦截策略。
   * ⚠️ 运行时默认 warn（只记账不注入）：reject 模式在真机上实测出现过
   *    "turn 结束不了 → 自跑几十步 → 烧额度" 的事故，默认必须是最安全的档。
   * 纯函数层（core/intercept.js）的 DEFAULT_POLICY.mode 仍是 reject，
   * 供调用方显式选择；插件半把默认压到 warn。
   */
  policy: {
    ...DEFAULT_POLICY,
    mode: 'warn',
    /** 同一 turn 最多驳回几次（必须是 1，否则会形成自跑循环） */
    maxRejectionsPerTurn: 1,
    /** 一个会话累计注入超过这一次数就熔断，彻底停止驳回 */
    sessionCircuit: 3,
  },
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

/** 探针：把加载过程中的关键节点写到固定文件，宿主没有日志通道时也能定位 */
const PROBE_PATH = 'C:\\Users\\hp\\.dsh\\deep-think-probe.log'
function probe(step, extra = '') {
  const line = `${new Date().toISOString()} | ${step} | ${extra}\n`
  try {
    // 同步 import fs 在沙箱里可能被禁，用动态 import + 忽略失败
    import('node:fs').then((fs) => fs.appendFileSync(PROBE_PATH, line)).catch(() => {})
  } catch {}
}

/** 一次性摸清 ctx 的真实形状：自有键、原型链、关键属性类型 */
function describeCtx(ctx) {
  const out = { own: [], proto: [], types: {} }
  try {
    out.own = Object.getOwnPropertyNames(ctx).slice(0, 40)
  } catch (e) {
    out.own = ['<err>']
  }
  try {
    let p = Object.getPrototypeOf(ctx)
    let d = 0
    while (p && d < 4) {
      out.proto.push(Object.getOwnPropertyNames(p).slice(0, 60))
      p = Object.getPrototypeOf(p)
      d++
    }
  } catch {}
  for (const k of ['on', 'tools', 'systemPrompt', 'harness', 'get', 'inject', 'logger', 'fiber', 'effect', 'agents', 'sessions']) {
    try {
      out.types[k] = typeof ctx[k]
    } catch {
      out.types[k] = 'throw'
    }
  }
  return out
}

export function apply(ctx, config = {}) {
  // 默认值取自 DEFAULT_CONFIG.policy（mode=warn）；调用方传入的 policy 覆盖它。
  // 注意不要在这里用 DEFAULT_POLICY 打底，否则会把默认 mode 从 warn 顶回 reject。
  const cfg = { ...DEFAULT_CONFIG, ...config, policy: { ...DEFAULT_CONFIG.policy, ...(config.policy || {}) } }
  const disposers = []

  probe(
    'apply:enter',
    `injectPrompt=${cfg.injectPrompt} registerTool=${cfg.registerTool} shape=${JSON.stringify(describeCtx(ctx))}`,
  )

  // ---------- 1. prompt 注入 ----------
  if (cfg.injectPrompt) {
    try {
      if (typeof ctx.systemPrompt?.section === 'function') {
        ctx.systemPrompt.section({ id: 'deep-think', order: 900, text: PROMPT_SECTION })
        ctx.logger?.info?.('deep-think: prompt section registered')
        probe('prompt:registered')
      } else {
        probe('prompt:no-api')
      }
    } catch (err) {
      ctx.logger?.warn?.(`deep-think: prompt 注入失败: ${err?.message ?? err}`)
    }
  }

  // ---------- 2. 工具注册 ----------
  if (cfg.registerTool) try {
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
        let sess
        try {
          sess = await loadSession()
        } catch (err) {
          return { ok: false, error: `无法加载会话读取模块（沙箱可能禁用了 fs）: ${err?.message ?? err}` }
        }
        const files = sess.listSessionFiles(undefined, 200)
        const picked = files.slice(-Math.max(1, args.limit || cfg.defaultLimit))
        const results = []
        for (const f of picked) {
          try {
            const { records, frames } = sess.readSessionFile(f)
            results.push({ file: f, frames, ...analyze(records, { thinActingThreshold: cfg.thinActingThreshold }) })
          } catch {}
        }
        if (!results.length) return { ok: false, error: '没有可解析的会话' }
        if (args.format === 'json') return { ok: true, data: results.map((r) => ({ file: r.file, summary: r.summary })) }
        return {
          ok: true,
          text: results
            .map((r) => renderReport(r, { title: String(r.file).split(/[\\/]/).slice(-2, -1)[0] || 'session' }))
            .join('\n\n---\n\n'),
        }
      },
    }
    // 工具定义必须先过 harness.defineTool 打标记，否则 ctx.tools.register 会拒收
    // （依据：app.asar 中 "the marker-guarded harness.defineTool / harness.registerTool pair"，
    //  以及 `import { defineTool } from "@deepseek-ai/dsh-tools"`）。
    // ⚠️ 探针血泪：ctx.harness / ctx.agents / ctx.sessions 未注入时**访问即抛**（typeof 为 'throw'）。
    //    所以探测必须包 try/catch，不能直接写成 !!ctx.harness —— 那会让 apply 当场中断。
    let hasTools = false
    let toolsShape = '-'
    try {
      hasTools = !!ctx.tools
      toolsShape = ctx.tools ? Object.keys(ctx.tools).join(',') : '-'
    } catch {
      toolsShape = '<throw>'
    }
    probe('tool:begin', `hasTools=${hasTools} toolsKeys=${toolsShape}`)
    let definition = tool
    for (const [label, maker] of [
      ['harness.defineTool', () => ctx.harness?.defineTool?.(tool)],
      ['ctx.defineTool', () => ctx.defineTool?.(tool)],
    ]) {
      try {
        const d = maker()
        if (d) {
          definition = d
          probe('tool:defined-by', label)
          break
        }
      } catch (err) {
        probe('tool:define-error', `${label}:${err?.message ?? err}`)
      }
    }

    let mounted = false
    for (const [label, fn] of [
      ['tools.register', () => ctx.tools?.register?.(definition)],
      ['tools.define', () => ctx.tools?.define?.(definition)],
      ['tools.add', () => ctx.tools?.add?.(tool)],
    ]) {
      try {
        if (fn() !== undefined) {
          mounted = true
          probe('tool:registered-by', label)
          break
        }
      } catch (err) {
        probe('tool:register-error', `${label}:${err?.message ?? err}`)
      }
    }
    if (!mounted) probe('tool:not-registered', 'all candidates failed')
    ctx.logger?.[mounted ? 'info' : 'warn']?.(
      mounted ? 'deep-think: tool registered' : 'deep-think: 工具注册 API 未命中（CLI 仍可用）',
    )
  } catch (err) {
    probe('tool:block-error', String(err?.message ?? err))
  }

  // ---------- 3. 拦截：累积每轮状态 ----------
  // 事故教训（2026-11-13）：状态不按 turn 重置 → 每步都用旧文本重复驳回 →
  // turn 永远结束不了 → 自跑 30 步、烧光额度。以下四条是补的刹车。
  const states = new Map()
  const st = (key) => {
    if (!states.has(key))
      states.set(key, {
        turn: null,
        answerText: '',
        toolCalls: 0,
        rejections: 0,
        rejectedHashes: new Set(),
        circuitOpen: false,
      })
    return states.get(key)
  }
  const keyOf = (agent, session) => agent?.id ?? session?.id ?? 'default'
  const hash = (s) => `${s.length}:${[...s].slice(0, 64).join('')}`

  /** 事件里带的 turn 一旦变化，立刻重置（不依赖 turn/start 事件是否被投递） */
  const syncTurn = (s, turn) => {
    if (turn === undefined || turn === null) return
    if (s.turn !== turn) {
      s.turn = turn
      s.answerText = ''
      s.toolCalls = 0
      s.rejections = 0
      s.rejectedHashes = new Set()
    }
  }

  disposers.push(
    ...onAny(ctx, ['session/event'], (session, event) => {
      if (!event || !event.type) return
      const s = st(keyOf(null, session))
      if (event.type === 'turn/start') {
        syncTurn(s, event.data?.turn ?? null)
        if (s.turn === null) {
          s.answerText = ''
          s.toolCalls = 0
          s.rejections = 0
          s.rejectedHashes = new Set()
        }
      } else if (event.type === 'tool/call') {
        syncTurn(s, event.data?.turn)
        s.toolCalls += 1
      } else if (event.type === 'assistant/message') {
        syncTurn(s, event.data?.turn)
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

    // 刹车 1：会话级熔断。一旦触发过几次，这个会话彻底不再驳回。
    if (s.circuitOpen) return
    // 刹车 2：只统计真正有正文的答案
    if (!s.answerText) return
    // 刹车 3：同一 turn 只允许驳回一次（原为每次 turn-stopping 都驳，是自跑 30 步的直接原因）
    if (s.rejections >= (cfg.policy.maxRejectionsPerTurn ?? 1)) return
    // 刹车 4：同一段文本不重复驳回（哈希去重）
    const h = hash(s.answerText)
    if (s.rejectedHashes.has(h)) return

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
      s.rejectedHashes.add(h)
      s.answerText = '' // 清空，等待重做的回答
      s.toolCalls = 0
      // 刹车 5：累计注入超过会话上限 → 熔断
      if (s.rejections >= (cfg.policy.sessionCircuit ?? 3)) {
        s.circuitOpen = true
        ctx.logger?.warn?.('deep-think: 会话级熔断，本会话后续不再驳回（防止自跑烧额度）')
      }
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
