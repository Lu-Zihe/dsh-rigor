/**
 * 拦截层核心（纯函数，可单测）。
 *
 * 判定目标：本轮回答里出现"事实断言但无来源"，且本轮检索不足 → 驳回。
 * 驳回不是删掉回答（宿主没有 output guard），而是往 agent 的 next-step inbox
 * 注入一条指令消息，让 turn 无法结束、模型必须重答。机制见 lib/index.js。
 */
import { countUnsourcedClaims } from './analyze.js'

export const DEFAULT_POLICY = {
  /** 同一 turn 最多驳回几次，超过则放行（防止死循环烧钱） */
  maxRejections: 2,
  /** 本轮至少要有几次工具调用，否则视为"没查就答" */
  minToolCalls: 1,
  /** 无源断言率超过该值 → 驳回 */
  maxUnsourcedRate: 0.25,
  /** 无源断言绝对条数超过该值 → 驳回（即使率不高） */
  maxUnsourcedCount: 3,
  /** 严重级别：'reject' 注入驳回消息；'warn' 只在报告里标；'off' 关闭 */
  mode: 'reject',
}

/**
 * 评估一个 turn 的回答是否合规。
 * @param {{answerText:string, toolCalls:number, rejections?:number}} input
 * @param {typeof DEFAULT_POLICY} policy
 * @returns {{ok:boolean, action:'pass'|'reject'|'give_up', violations:string[], detail:object}}
 */
export function evaluateTurn(input, policy = DEFAULT_POLICY) {
  const p = { ...DEFAULT_POLICY, ...policy }
  const answer = input.answerText || ''
  const toolCalls = input.toolCalls || 0
  const rejections = input.rejections || 0
  const claims = countUnsourcedClaims(answer)
  const violations = []

  if (p.mode === 'off') {
    return { ok: true, action: 'pass', violations: [], detail: { ...claims, toolCalls, mode: 'off' } }
  }

  // 规则 1：本 turn 一次工具都没调，却给出了带数字的结论
  if (toolCalls < p.minToolCalls && claims.numericLines > 0) {
    violations.push(
      `本轮 0 次检索，却给出了 ${claims.numericLines} 处含数字的结论。数字必须有来源。`,
    )
  }

  // 规则 2：无源断言超阈值
  if (claims.numericLines > 0) {
    const rate = claims.unsourced / claims.numericLines
    if (claims.unsourced >= p.maxUnsourcedCount || rate > p.maxUnsourcedRate) {
      violations.push(
        `${claims.numericLines} 处含数字的句子里有 ${claims.unsourced} 处没有任何来源标记` +
          `（率 ${rate.toFixed(2)}）。要么补检索，要么删掉或标【未核实】。`,
      )
      if (claims.samples.length) {
        violations.push(`示例：\n` + claims.samples.map((s, i) => `  ${i + 1}. ${s}`).join('\n'))
      }
    }
  }

  if (!violations.length) {
    return { ok: true, action: 'pass', violations: [], detail: { ...claims, toolCalls } }
  }

  if (rejections >= p.maxRejections) {
    return {
      ok: false,
      action: 'give_up',
      violations,
      detail: { ...claims, toolCalls, rejections, note: '已达驳回上限，放行并记账' },
    }
  }

  return { ok: false, action: p.mode === 'warn' ? 'pass' : 'reject', violations, detail: { ...claims, toolCalls } }
}

/** 生成注入给模型的驳回指令 */
export function buildRejectionMessage(violations, attempt) {
  return [
    `【rigor 驳回 · 第 ${attempt} 次】本轮回答未通过硬性检查，请重做。`,
    '',
    ...violations.map((v) => `- ${v}`),
    '',
    '要求：',
    '1. 先用工具检索，拿到来源（文件路径 + 行号，或 URL）。',
    '2. 每个数字 / 日期 / 规范名后面能指出来源。',
    '3. 拿不到来源的内容，删除或显式标【未核实】。',
    '4. 不要重复上一版的措辞，重新组织。',
  ].join('\n')
}

/** 构造注入用的消息体（尽量贴近宿主 user-message 形态） */
export function buildInjectedMessage(text, counter) {
  return {
    id: `rigor-reject-${Date.now()}-${counter}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'agent-instructions', form: 'instructions' },
  }
}
