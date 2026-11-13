/**
 * 核心指标：每一轮（turn）的「深度画像」。
 *
 * 设计依据（2026-11-13 实测本机会话）：
 *   reasoning 块存在，但经常只有一两句就调用工具。所以核心指标是
 *   「第一次工具调用之前，推理写了多少字」——thinkingBeforeActing。
 */

const SOURCE_MARKERS = [
  'http', 'https', '.md', '.pdf', '.docx', '.json', '.py', '.js', '.ts',
  '.cpp', '.c', '.h', '来源', '摘自', '原文', '文档', '行号', '据 ', '根据',
  'API', '★', 'path:', 'file:',
]

const NUMERIC_HINT = /(?:\d+(?:\.\d+)?\s*(?:%|pp|万|亿|元|天|周|年|月|日|小时|分钟|次|名|支|条|页|章|题))|(?:\d{4}-\d{2}-\d{2})|(?:\d{3,})/

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && (b.type === 'text' || b.type === 'reasoning'))
    .map((b) => b.text || '')
    .join('')
}

/** 从一条 assistant/message 提取推理与工具调用 */
function splitAssistant(msg) {
  const content = msg?.data?.message?.content
  const reasoning = []
  const answer = []
  let toolCalls = 0
  let sawTool = false
  let beforeFirstTool = 0
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'reasoning') {
        const t = block.text || ''
        reasoning.push(t)
        if (!sawTool) beforeFirstTool += t.length
      } else if (block.type === 'text') {
        answer.push(block.text || '')
      } else if (block.type === 'tool-call' || block.type === 'tool_call') {
        toolCalls += 1
        sawTool = true
      }
    }
  }
  return { reasoning: reasoning.join('\n'), answer: answer.join('\n'), toolCalls, beforeFirstTool }
}

/** 无源断言计数：含数字/日期的句子，且该句没有任何来源标记
 *  已知局限：对中文 Markdown 表格会高估（表格行的来源通常在表头或正文），
 *  所以跳过以 | 开头的行、过短的碎行、以及已标【推断】的行。看趋势不看单点。
 */
export function countUnsourcedClaims(answer) {
  if (!answer) return { numericLines: 0, unsourced: 0, samples: [] }
  const lines = answer
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  let numericLines = 0
  let unsourced = 0
  const samples = []
  for (const raw of lines) {
    const line = raw.replace(/^[-*+]\s+/, '')
    if (line.startsWith('|')) continue // 表格行：来源在表外
    if (line.length < 16) continue // 碎行
    if (line.includes('【推断】') || line.includes('【未核实】')) continue // 已显式标注
    if (!NUMERIC_HINT.test(line)) continue
    numericLines += 1
    // 「没有来源 / 无来源」这类否定说法里出现"来源"二字，不能被当成有来源
    const negated = /(没有|没写|未写|缺少|缺失|无)[^，。；\n]{0,6}(来源|标注|出处)/.test(line)
    const hasSource = !negated && SOURCE_MARKERS.some((m) => line.includes(m))
    if (!hasSource) {
      unsourced += 1
      if (samples.length < 3) samples.push(line.slice(0, 80))
    }
  }
  return { numericLines, unsourced, samples }
}

/**
 * @param {any[]} records
 * @returns {{turns: any[], summary: any}}
 */
export function analyze(records, opts = {}) {
  const turns = new Map()
  let effort = null
  let model = null
  let effortHistory = []
  /** 真人消息，按出现顺序收集；最后与轮次按序对齐（宿主里 user/message 与 turn/start 先后不固定） */
  const users = []

  const getTurn = (n) => {
    if (!turns.has(n)) {
      turns.set(n, {
        turn: n,
        userText: '',
        reasoningChars: 0,
        thinkingBeforeActing: 0,
        toolCalls: 0,
        answerChars: 0,
        steps: 0,
        unsourced: 0,
        numericLines: 0,
        samples: [],
        effort,
        model,
      })
    }
    return turns.get(n)
  }

  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    const d = r.data || {}
    switch (r.type) {
      case 'request/header': {
        const cfg = d.header?.config
        if (cfg) {
          if (cfg.reasoningEffort !== undefined) {
            effort = cfg.reasoningEffort
            effortHistory.push(effort)
          }
          if (cfg.model) model = cfg.model
        }
        break
      }
      case 'user/message': {
        // 只有 source.kind === 'user' 才是真人输入；
        // runtime-context / user-approval 是系统注入，不能当成一轮。
        if (d.source?.kind === 'user') {
          users.push(String(d.content?.[0]?.text ?? textOf(d.content)).slice(0, 4000))
        }
        break
      }
      case 'turn/start': {
        getTurn(d.turn)
        break
      }
      case 'assistant/message': {
        const t = getTurn(d.turn)
        const s = splitAssistant(r)
        t.reasoningChars += s.reasoning.length
        t.toolCalls += s.toolCalls
        // 关键：只取「本 turn 第一步」动手前的推理。
        // 用 max 会被后面某步的长推理掩盖"第一步就想两句"的真实问题。
        if (!t.firstStepSeen) {
          t.firstStepSeen = true
          t.thinkingBeforeActing = s.beforeFirstTool
          t.firstStepToolCalls = s.toolCalls
        }
        t.answerChars += s.answer.length
        const u = countUnsourcedClaims(s.answer)
        t.numericLines += u.numericLines
        t.unsourced += u.unsourced
        if (u.samples.length) t.samples.push(...u.samples.slice(0, 2))
        t.effort = effort ?? t.effort
        t.model = model ?? t.model
        break
      }
      case 'step/start': {
        const t = getTurn(d.turn)
        t.steps += 1
        break
      }
      default:
        break
    }
  }

  // 只保留"真的发生了动作"的轮次：有工具调用或有回答。
  // 系统注入消息（runtime-context 等）不再产生幽灵轮。
  const list = [...turns.values()]
    .filter((t) => t.answerChars > 0 || t.toolCalls > 0)
    .sort((a, b) => a.turn - b.turn)

  // 按出现顺序把真人消息对齐到轮次（1:1 近似；若某轮被中断而无产出，会错位一格）
  for (let i = 0; i < list.length && i < users.length; i++) {
    if (!list[i].userText) list[i].userText = users[i]
  }

  const sum = (k) => list.reduce((a, b) => a + (b[k] || 0), 0)
  const totalReasoning = sum('reasoningChars')
  const totalAnswer = sum('answerChars')
  const totalTools = sum('toolCalls')
  const totalUnsourced = sum('unsourced')
  const thin = list.filter((t) => t.thinkingBeforeActing < (opts?.thinActingThreshold ?? 120)).length

  const summary = {
    turns: list.length,
    totalReasoning,
    totalAnswer,
    totalTools,
    totalUnsourced,
    /** 深度指数：推理字数 / 回答字数（越高越是"先想后写"） */
    depthRatio: totalAnswer > 0 ? +(totalReasoning / totalAnswer).toFixed(3) : null,
    /** 动手前推理 < 120 字的轮次占比 —— 核心告警指标 */
    thinActingRate: list.length > 0 ? +(thin / list.length).toFixed(3) : null,
    thinActingTurns: thin,
    /** 无源断言率 */
    unsourcedRate: sum('numericLines') > 0 ? +(totalUnsourced / sum('numericLines')).toFixed(3) : null,
    effortHistory: [...new Set(effortHistory)],
    model,
    avgReasoningPerTurn: list.length ? Math.round(totalReasoning / list.length) : 0,
    avgThinkingBeforeActing: list.length
      ? Math.round(list.reduce((a, b) => a + b.thinkingBeforeActing, 0) / list.length)
      : 0,
  }

  return { turns: list, summary }
}

/** Markdown 报告 */
export function renderReport({ turns, summary }, opts = {}) {
  const name = opts.title || 'deep-think 报告'
  const L = []
  L.push(`# ${name}`)
  L.push('')
  L.push(`> 生成于 ${new Date().toISOString()}　|　模型 \`${summary.model || '?'}\`　|　effort: ${summary.effortHistory.join(' → ') || '?'}`)
  L.push('')
  L.push('## 总览')
  L.push('')
  L.push('| 指标 | 值 | 含义 |')
  L.push('|---|---:|---|')
  L.push(`| 轮次 | ${summary.turns} | 有内容的 turn 数 |`)
  L.push(`| 深度指数 | ${summary.depthRatio ?? '—'} | 推理字数 ÷ 回答字数 |`)
  L.push(`| 平均动手前推理 | ${summary.avgThinkingBeforeActing} 字 | 第一次调用工具之前写了多少 |`)
  L.push(`| **急切动手率** | **${summary.thinActingRate ?? '—'}** | 动手前推理 < 120 字的轮次占比 |`)
  L.push(`| 无源断言率 | ${summary.unsourcedRate ?? '—'} | 含数字且无来源标记的行占比 |`)
  L.push(`| 工具调用合计 | ${summary.totalTools} | |`)
  L.push('')
  L.push('## 逐轮明细（最急的前 12 轮）')
  L.push('')
  L.push('| turn | 用户 | 动手前推理 | 工具 | 回答 | 无源 |')
  L.push('|---:|---|---:|---:|---:|---:|')
  const worst = [...turns].sort((a, b) => a.thinkingBeforeActing - b.thinkingBeforeActing).slice(0, 12)
  for (const t of worst) {
    L.push(
      `| ${t.turn} | ${(t.userText || '').slice(0, 24).replace(/\|/g, '\\|')} | ${t.thinkingBeforeActing} | ${t.toolCalls} | ${t.answerChars} | ${t.unsourced} |`,
    )
  }
  L.push('')
  L.push('## 判定')
  L.push('')
  if (summary.thinActingRate !== null && summary.thinActingRate > 0.5) {
    L.push('🔴 **急切动手率过高**：过半轮次在动手前推理不足 120 字。这不是 effort 不够，是"先做后想"。')
  } else if (summary.unsourcedRate !== null && summary.unsourcedRate > 0.3) {
    L.push('🟠 **无源断言过多**：含数字的句子里三成以上没有任何来源标记。')
  } else {
    L.push('🟢 未触发告警阈值。')
  }
  L.push('')
  L.push('_指标是启发式的：无源断言按"含数字但无来源标记的行"计数，会有误差，看趋势不看单点。_')
  return L.join('\n')
}
