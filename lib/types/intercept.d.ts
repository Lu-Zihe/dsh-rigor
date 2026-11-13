/** 拦截层（core/intercept.js） */

export interface Policy {
  /** 同一 turn 最多驳回几次，超过放行，默认 2 */
  maxRejections: number
  /** 本轮至少几次工具调用，默认 1 */
  minToolCalls: number
  /** 无源断言率上限，默认 0.25 */
  maxUnsourcedRate: number
  /** 无源断言绝对条数上限，默认 3 */
  maxUnsourcedCount: number
  /** reject = 注入驳回；warn = 只记账；off = 关闭 */
  mode: 'reject' | 'warn' | 'off'
}

export const DEFAULT_POLICY: Policy

export interface TurnInput {
  answerText: string
  toolCalls: number
  rejections?: number
}

export interface Verdict {
  ok: boolean
  action: 'pass' | 'reject' | 'give_up'
  violations: string[]
  detail: {
    numericLines?: number
    unsourced?: number
    samples?: string[]
    toolCalls?: number
    rejections?: number
    mode?: string
    note?: string
  }
}

export function evaluateTurn(input: TurnInput, policy?: Partial<Policy>): Verdict

export function buildRejectionMessage(violations: string[], attempt: number): string

export function buildInjectedMessage(
  text: string,
  counter: number,
): {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'agent-instructions'; form: 'instructions' }
}
