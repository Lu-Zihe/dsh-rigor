/** 指标计算与报告（core/analyze.js） */

export interface TurnMetrics {
  turn: number
  userText: string
  /** 本 turn 累加的推理字数 */
  reasoningChars: number
  /** 第一步、第一次工具调用之前的推理字数（核心指标） */
  thinkingBeforeActing: number
  toolCalls: number
  answerChars: number
  steps: number
  /** 无源断言条数 */
  unsourced: number
  /** 含数字的行数 */
  numericLines: number
  /** 无源断言的样例（最多 3 条） */
  samples: string[]
  effort?: string | null
  model?: string | null
  /** 内部：是否已见过第一步 */
  firstStepSeen?: boolean
  firstStepToolCalls?: number
}

export interface Summary {
  turns: number
  totalReasoning: number
  totalAnswer: number
  totalTools: number
  totalUnsourced: number
  /** 推理字数 ÷ 回答字数；无回答时为 null */
  depthRatio: number | null
  /** thinkingBeforeActing < 阈值 的轮次占比；无轮次时为 null */
  thinActingRate: number | null
  thinActingTurns: number
  /** 无源断言 ÷ 含数字行；无含数字行时为 null */
  unsourcedRate: number | null
  effortHistory: string[]
  model: string | null
  avgReasoningPerTurn: number
  avgThinkingBeforeActing: number
}

export interface AnalyzeResult {
  turns: TurnMetrics[]
  summary: Summary
}

export interface AnalyzeOptions {
  /** 急切动手阈值（字），默认 120 */
  thinActingThreshold?: number
}

export function analyze(records: unknown[], opts?: AnalyzeOptions): AnalyzeResult

export function countUnsourcedClaims(answer: string): {
  numericLines: number
  unsourced: number
  samples: string[]
}

export function renderReport(
  result: AnalyzeResult,
  opts?: { title?: string },
): string
