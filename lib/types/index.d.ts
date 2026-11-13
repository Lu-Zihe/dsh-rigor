/** DSH 插件入口（lib/index.js） */
import type { Policy } from './intercept.js'

export interface DeepThinkConfig {
  /** 是否向系统提示注入「深度思考协议」，默认 true */
  injectPrompt?: boolean
  /** 是否注册 deepthink_report 工具，默认 true */
  registerTool?: boolean
  /** deepthink_report 默认分析最近几个会话，默认 1 */
  defaultLimit?: number
  /** 急切动手阈值（字），默认 120 */
  thinActingThreshold?: number
  /** 拦截策略 */
  policy?: Partial<Policy>
}

export declare const name: 'dsh-deep-think'

export declare const DEFAULT_CONFIG: {
  injectPrompt: boolean
  registerTool: boolean
  defaultLimit: number
  thinActingThreshold: number
  policy: Policy
}

/**
 * Cordis 插件入口。
 * 任何一半（prompt 注入 / 工具注册 / 拦截注入）失败都只降级并记日志，不抛错。
 * @returns dispose 函数
 */
export declare function apply(ctx: unknown, config?: DeepThinkConfig): () => void
